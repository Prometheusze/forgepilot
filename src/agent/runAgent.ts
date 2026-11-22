// src/agent/runAgent.ts
import * as vscode from 'vscode';
import * as path from 'node:path';
import { getForgePilotConfig } from '../trueforge/config.js';
import { getOrStartMcpServer } from '../mcp/server.js';
import {
  registerMcpServer,
  createAgentSession,
  createTurnStream,
  postTurnApprovalEvents,
  subscribeTurnStream,
  getTurn,
  createTurnEventsLister,
  cancelSession,
} from '../trueforge/session.js';
import { executeWithFallback } from '../trueforge/fallbackRunner.js';
import { parseProposeEditArgs, canonicalKey } from '../review/proposal.js';
import { reviewProposal, cancelActiveReview } from '../review/reviewUi.js';
import { put as putDecision } from '../review/decisions.js';
import { resolveToolCall } from './toolResolve.js';
import { uiEventBus, RunMode } from '../ui/eventBus.js';

let activeCancelCallback: (() => void) | null = null;

/**
 * Aborts any active agent run in-flight.
 */
export function abortActiveAgentRun(): void {
  if (activeCancelCallback) {
    activeCancelCallback();
  }
}

function truncate(str: string, maxLen: number): string {
  const flattened = str.replace(/[\r\n]+/g, ' ').trim();
  if (flattened.length <= maxLen) {
    return flattened;
  }
  return flattened.slice(0, maxLen) + '...';
}

/**
 * Formats a non-delta TrueForge TurnStreamingEvent into a concise single-line summary.
 */
export function formatEventSummary(event: any): string | null {
  if (!event || !event.type) {
    return null;
  }

  switch (event.type) {
    case 'model.message': {
      if (Array.isArray(event.toolCalls) && event.toolCalls.length > 0) {
        const calls = event.toolCalls.map((c: any) => {
          const fnName = c.function?.name ?? 'unknown_tool';
          const fnArgs = truncate(c.function?.arguments ?? '', 100);
          return `[model.message] tool_call: ${fnName}(${fnArgs})`;
        });
        return calls.join('\n');
      }
      return `[model.message] message completed`;
    }
    case 'tool.response': {
      const toolId = event.toolCallId ?? 'unknown';
      const result = truncate(event.content ?? '', 120);
      return `[tool.response] id=${toolId} result: ${result}`;
    }
    case 'tool.response_required': {
      const count = Array.isArray(event.toolCalls) ? event.toolCalls.length : 1;
      return `[tool.response_required] ${count} tool call(s) pending response`;
    }
    case 'tool.approval_required': {
      return `[tool.approval_required] tool calls awaiting approval`;
    }
    case 'mcp.initialize': {
      const servers = Array.isArray(event.mcpServers)
        ? event.mcpServers.map((s: any) => s.name).join(', ')
        : 'unknown';
      return `[mcp.initialize] initialized servers: ${servers}`;
    }
    case 'mcp.auth_required': {
      return `[mcp.auth_required] MCP server authentication required`;
    }
    case 'turn.created': {
      return `[turn.created] turn started`;
    }
    case 'turn.update': {
      const status = event.state?.status ?? 'running';
      return `[turn.update] state=${status}`;
    }
    case 'turn.done': {
      const status = event.state?.status ?? 'done';
      const msg = event.state?.message ? `: ${event.state.message}` : '';
      return `[turn.done] status=${status}${msg}`;
    }
    default:
      return `[${event.type}]`;
  }
}

export interface RunAgentTurnOptions {
  channel: vscode.OutputChannel;
  prompt: string;
  workspaceRoot: string;
  runTitle?: string;
  runMode?: RunMode;
  customInstructions?: string;
  runGeneration: number;
  isCurrentGen: () => boolean;
  setActiveSessionId: (id: string | null) => void;
}

/**
 * Universal Turn Runner with Automatic Model Fallback across forgepilot.models.
 * Used by Ask Agent, Inline Edit, and Agent Mode.
 */
export async function executeAgentTurnWithFallback(options: RunAgentTurnOptions): Promise<void> {
  const { channel, prompt, workspaceRoot, runGeneration, isCurrentGen, setActiveSessionId } = options;

  const config = getForgePilotConfig();
  if (!config.models || config.models.length === 0) {
    vscode.window.showErrorMessage(
      'ForgePilot: No models configured. Please set "forgepilot.models" in VS Code settings.'
    );
    return;
  }

  if (!isCurrentGen()) {
    return;
  }

  let userCancelled = false;
  activeCancelCallback = () => {
    userCancelled = true;
  };

  const isCancelled = () => !isCurrentGen() || userCancelled;

  uiEventBus.emit({
    type: 'runStart',
    generation: runGeneration,
    mode: options.runMode || 'agent',
    prompt,
    model: config.models[0],
    trueforgeUrl: config.baseUrl,
    contextEngineering: ['compaction', 'large_tool_response', 'deferred: get_symbols'],
  });

  channel.show(true);
  channel.appendLine(`\n>>> ${options.runTitle || 'ForgePilot: Ask Agent'} (Run #${runGeneration})`);
  channel.appendLine(`Workspace: ${workspaceRoot}`);
  channel.appendLine(`Primary Model: ${config.models[0]}`);
  if (config.models.length > 1) {
    channel.appendLine(`Fallback Candidates: ${config.models.slice(1).join(', ')}`);
  }
  channel.appendLine(`Prompt: ${prompt}\n`);

  await vscode.commands.executeCommand('setContext', 'forgepilot.running', true);

  try {
    // 1. Ensure local MCP server is running with explicit workspace root and configured pacing
    const mcp = await getOrStartMcpServer(config.mcpPort, workspaceRoot, {
      toolCallPacingMs: config.toolCallPacingMs,
    });
    if (isCancelled()) {
      return;
    }

    // 2. Register MCP server with TrueForge
    channel.appendLine(`[mcp.register] registering forgepilot-editor at ${mcp.redactedUrl}...`);
    const regResult = await registerMcpServer(config.baseUrl, mcp.port, mcp.token);
    if (isCancelled()) {
      return;
    }
    channel.appendLine(`[mcp.register] registration status: ${regResult.status} OK\n`);

    // 3. Execute with automatic model fallback across config.models
    await executeWithFallback(
      config.models,
      async (modelName, isFallback) => {
        if (isCancelled()) {
          throw new Error('Cancelled by user');
        }

        channel.appendLine(
          `\n[Session Init] Initializing TrueForge session with model: ${modelName}${isFallback ? ' (FALLBACK)' : ''}...`
        );

        let sessionId: string | null = null;
        let currentTurnId: string | null = null;
        let lastSeenEventId: string | undefined = undefined;
        let rawApprovalPrinted = false;
        let rawProposeEditPrinted = false;
        let rawResolvedEventPrinted = false;

        interface ToolCallRecord {
          id: string;
          name: string;
          arguments: string;
          threadId: string;
        }
        const knownToolCalls = new Map<string, ToolCallRecord>();

        sessionId = await createAgentSession(modelName, options.customInstructions);
        if (isCancelled()) {
          throw new Error('Cancelled by user');
        }
        setActiveSessionId(sessionId);

        uiEventBus.emit({
          type: 'sessionCreated',
          generation: runGeneration,
          sessionId,
          model: modelName,
        });

        channel.appendLine(`[TrueForge] Session ID: ${sessionId}`);
        channel.appendLine(`[TrueForge] UI: ${config.baseUrl}`);
        channel.appendLine(
          '[TrueForge] Context-engineering: Compaction (enabled=true), LargeToolResponse (enabled=true), McpPreloadTools ([read_file, search_workspace, propose_edit, run_terminal_command]), Deferred ([get_symbols])'
        );

        let stream = await createTurnStream(sessionId, prompt);
        let turnDone = false;
        let finalTurnStatus: string | null = null;
        let finalErrorMessage: string | undefined = undefined;

        while (!turnDone && !isCancelled()) {
          let paused = false;
          let pendingApprovals: { id: string; threadId: string; sourceEventId?: string }[] = [];

          try {
            for await (const event of stream) {
              if (isCancelled()) {
                break;
              }

              if (event.id) {
                lastSeenEventId = event.id;
              }

              if (event.type === 'turn.created') {
                currentTurnId = event.turnId || event.turn_id;
              }

              if (event.type === 'model.message.delta') {
                if (typeof event.content === 'string') {
                  channel.append(event.content);
                  uiEventBus.emit({
                    type: 'streamDelta',
                    generation: runGeneration,
                    delta: event.content,
                  });
                }
              } else {
                const summary = formatEventSummary(event);
                if (summary) {
                  channel.appendLine(`\n${summary}`);
                }
              }

              if (event.type === 'model.message' && Array.isArray(event.toolCalls)) {
                for (const tc of event.toolCalls) {
                  const fnName = tc.function?.name ?? '';
                  const fnArgs = tc.function?.arguments ?? '';
                  knownToolCalls.set(tc.id, {
                    id: tc.id,
                    name: fnName,
                    arguments: fnArgs,
                    threadId: event.threadId || event.thread_id || 'main',
                  });

                  let target = '';
                  try {
                    const parsed = JSON.parse(fnArgs || '{}');
                    target = parsed.path || parsed.command || parsed.query || '';
                  } catch {
                    target = '';
                  }

                  uiEventBus.emit({
                    type: 'toolCall',
                    generation: runGeneration,
                    id: tc.id,
                    name: fnName,
                    target,
                    status: 'running',
                  });

                  if (fnName.endsWith('propose_edit') && !rawProposeEditPrinted) {
                    channel.appendLine(
                      '\n[model.message propose_edit raw] ' + truncate(JSON.stringify(tc), 2000)
                    );
                    rawProposeEditPrinted = true;
                  }
                }
              }

              if (event.type === 'tool.approval_required') {
                if (!rawApprovalPrinted) {
                  channel.appendLine(
                    '\n[tool.approval_required raw] ' + truncate(JSON.stringify(event), 2000)
                  );
                  rawApprovalPrinted = true;
                }

                const toolCalls = Array.isArray(event.toolCalls) ? event.toolCalls : [];
                pendingApprovals = toolCalls.map((ref: any) => ({
                  id: ref.id,
                  threadId: event.threadId || event.thread_id || 'main',
                  sourceEventId: ref.sourceEventId || ref.source_event_id,
                }));

                for (const ref of pendingApprovals) {
                  uiEventBus.emit({
                    type: 'toolCall',
                    generation: runGeneration,
                    id: ref.id,
                    name: 'pending_tool',
                    target: '',
                    status: 'awaiting_approval',
                  });
                }
              }

              if (event.type === 'tool.response' && event.toolCallId) {
                uiEventBus.emit({
                  type: 'toolCall',
                  generation: runGeneration,
                  id: event.toolCallId,
                  name: '',
                  target: '',
                  status: 'done',
                });
              }

              if (event.type === 'turn.update' && event.state?.status === 'paused') {
                paused = true;
                break;
              }

              if (event.type === 'turn.done') {
                turnDone = true;
                finalTurnStatus = event.state?.status ?? 'done';
                if (finalTurnStatus === 'error') {
                  finalErrorMessage = event.state?.message || 'Turn ended with error state';
                }
                break;
              }
            }
          } catch (err: unknown) {
            if (isCancelled()) {
              break;
            }
            throw err;
          }

          if (isCancelled()) {
            break;
          }

          if (turnDone) {
            break;
          }

          // Hang protection
          if (!paused) {
            if (currentTurnId && sessionId) {
              channel.appendLine(
                '\n[Stream closed prematurely without turn.done or paused state; querying turn state...]'
              );
              try {
                const turnInfo = await getTurn(sessionId, currentTurnId);
                const status = turnInfo.state?.status ?? 'unknown';
                const msg = turnInfo.state?.message ? `: ${turnInfo.state.message}` : '';
                channel.appendLine(`[Turn status] state=${status}${msg}`);
                throw new Error(`Turn terminated prematurely with state: ${status}${msg}`);
              } catch (fetchErr: unknown) {
                const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
                channel.appendLine(`[Failed to query turn state]: ${msg}`);
                throw new Error(`Turn stream closed prematurely: ${msg}`);
              }
            } else {
              channel.appendLine('\n[Stream closed prematurely before turn initialization]');
              throw new Error('Turn stream closed prematurely.');
            }
          }

          if (!currentTurnId) {
            throw new Error('Turn paused but turnId was not captured.');
          }

          // Process approval decisions for all pending calls
          const listEvents = await createTurnEventsLister(sessionId, currentTurnId);
          const approvalEvents: any[] = [];

          for (const pending of pendingApprovals) {
            if (isCancelled()) {
              break;
            }

            let resolved = await resolveToolCall(
              { id: pending.id, sourceEventId: pending.sourceEventId ?? '' },
              listEvents
            );

            if (!resolved) {
              const fallback = knownToolCalls.get(pending.id);
              if (fallback && fallback.name) {
                resolved = {
                  name: fallback.name,
                  argumentsJson: fallback.arguments,
                  rawEventJson: JSON.stringify(fallback),
                };
              }
            }

            if (!resolved) {
              channel.appendLine(
                `[approval] could not identify tool call ${pending.id}; denying approval`
              );
              approvalEvents.push({
                type: 'user.tool_approval',
                threadId: pending.threadId,
                toolCallId: pending.id,
                approval: {
                  status: 'deny',
                  reason: 'ForgePilot could not identify this tool call; nothing was applied',
                },
              });
              continue;
            }

            channel.appendLine(`[approval] resolved ${resolved.name} (call ${pending.id})`);
            if (!rawResolvedEventPrinted) {
              channel.appendLine(
                '\n[resolved event raw] ' + truncate(resolved.rawEventJson, 2000)
              );
              rawResolvedEventPrinted = true;
            }

            const toolName = resolved.name;

            if (toolName.endsWith('propose_edit')) {
              let parsedJson: unknown = null;
              try {
                parsedJson = JSON.parse(resolved.argumentsJson || '{}');
              } catch {
                parsedJson = null;
              }

              const parsed = parseProposeEditArgs(parsedJson);
              if (!parsed.ok) {
                channel.appendLine(`[approval] propose_edit -> invalid args: ${parsed.error}`);
                approvalEvents.push({
                  type: 'user.tool_approval',
                  threadId: pending.threadId,
                  toolCallId: pending.id,
                  approval: {
                    status: 'deny',
                    reason: `Invalid propose_edit arguments: ${parsed.error}`,
                  },
                });
                continue;
              }

              const outcome = await reviewProposal(parsed.args, workspaceRoot, isCancelled);

              if (outcome.kind === 'cancelled' || isCancelled()) {
                channel.appendLine('[approval] propose_edit -> review cancelled by user');
                if (sessionId) {
                  await cancelSession(sessionId);
                }
                throw new Error('Cancelled by user');
              }

              if (outcome.kind === 'applied') {
                putDecision(canonicalKey(parsed.args), outcome);
                channel.appendLine(
                  `[approval] propose_edit ${path.basename(outcome.path)} -> applied ${outcome.acceptedHunkIds.length}/${outcome.totalHunks} hunks`
                );
                approvalEvents.push({
                  type: 'user.tool_approval',
                  threadId: pending.threadId,
                  toolCallId: pending.id,
                  approval: { status: 'allow' },
                });
                uiEventBus.emit({
                  type: 'toolApproval',
                  generation: runGeneration,
                  id: pending.id,
                  status: 'approved',
                });
              } else if (outcome.kind === 'rejected') {
                channel.appendLine(
                  `[approval] propose_edit ${path.basename(parsed.args.path)} -> rejected: ${outcome.reason}`
                );
                approvalEvents.push({
                  type: 'user.tool_approval',
                  threadId: pending.threadId,
                  toolCallId: pending.id,
                  approval: {
                    status: 'deny',
                    reason: 'User rejected all hunks; do not re-propose the same change.',
                  },
                });
                uiEventBus.emit({
                  type: 'toolApproval',
                  generation: runGeneration,
                  id: pending.id,
                  status: 'denied',
                });
              } else if (outcome.kind === 'invalid') {
                channel.appendLine(
                  `[approval] propose_edit ${path.basename(parsed.args.path)} -> invalid: ${outcome.reason}`
                );
                approvalEvents.push({
                  type: 'user.tool_approval',
                  threadId: pending.threadId,
                  toolCallId: pending.id,
                  approval: {
                    status: 'deny',
                    reason: `Edit failed: ${outcome.reason}`,
                  },
                });
                uiEventBus.emit({
                  type: 'toolApproval',
                  generation: runGeneration,
                  id: pending.id,
                  status: 'denied',
                });
              } else if (outcome.kind === 'stale') {
                channel.appendLine(
                  `[approval] propose_edit ${path.basename(parsed.args.path)} -> stale: ${outcome.reason}`
                );
                approvalEvents.push({
                  type: 'user.tool_approval',
                  threadId: pending.threadId,
                  toolCallId: pending.id,
                  approval: {
                    status: 'deny',
                    reason:
                      'File changed during review. Call read_file again to get the latest file content and re-propose.',
                  },
                });
                uiEventBus.emit({
                  type: 'toolApproval',
                  generation: runGeneration,
                  id: pending.id,
                  status: 'denied',
                });
              }
            } else if (toolName.endsWith('run_terminal_command')) {
              let commandArgs: { command?: string; cwd?: string } = {};
              try {
                commandArgs = JSON.parse(resolved.argumentsJson || '{}');
              } catch {
                commandArgs = {};
              }
              const cmdText = commandArgs.command || '(unknown command)';
              const cwdText = commandArgs.cwd || '.';

              const quickPick = await vscode.window.showQuickPick(
                [
                  {
                    label: '$(check) Approve Terminal Command',
                    description: `Run: "${cmdText}" in ${cwdText}`,
                    action: 'allow',
                  },
                  {
                    label: '$(x) Deny Execution',
                    description: 'Reject running this command',
                    action: 'deny',
                  },
                ],
                {
                  title: 'Approve Terminal Command',
                  placeHolder: `Agent requested execution of: ${cmdText}`,
                  ignoreFocusOut: true,
                }
              );

              if (quickPick && quickPick.action === 'allow') {
                channel.appendLine(`[approval] run_terminal_command "${cmdText}" -> approved by user`);
                approvalEvents.push({
                  type: 'user.tool_approval',
                  threadId: pending.threadId,
                  toolCallId: pending.id,
                  approval: { status: 'allow' },
                });
                uiEventBus.emit({
                  type: 'toolApproval',
                  generation: runGeneration,
                  id: pending.id,
                  status: 'approved',
                });
              } else {
                channel.appendLine(`[approval] run_terminal_command "${cmdText}" -> denied by user`);
                approvalEvents.push({
                  type: 'user.tool_approval',
                  threadId: pending.threadId,
                  toolCallId: pending.id,
                  approval: {
                    status: 'deny',
                    reason: 'User denied terminal command execution.',
                  },
                });
                uiEventBus.emit({
                  type: 'toolApproval',
                  generation: runGeneration,
                  id: pending.id,
                  status: 'denied',
                });
              }
            } else {
              const modalPick = await vscode.window.showInformationMessage(
                `Agent requests approval for tool "${toolName}". Allow?`,
                { modal: true },
                'Allow',
                'Deny'
              );

              if (modalPick === 'Allow') {
                channel.appendLine(`[approval] ${toolName} -> allowed by user`);
                approvalEvents.push({
                  type: 'user.tool_approval',
                  threadId: pending.threadId,
                  toolCallId: pending.id,
                  approval: { status: 'allow' },
                });
                uiEventBus.emit({
                  type: 'toolApproval',
                  generation: runGeneration,
                  id: pending.id,
                  status: 'approved',
                });
              } else {
                channel.appendLine(`[approval] ${toolName} -> denied by user`);
                approvalEvents.push({
                  type: 'user.tool_approval',
                  threadId: pending.threadId,
                  toolCallId: pending.id,
                  approval: {
                    status: 'deny',
                    reason: 'User denied tool call.',
                  },
                });
                uiEventBus.emit({
                  type: 'toolApproval',
                  generation: runGeneration,
                  id: pending.id,
                  status: 'denied',
                });
              }
            }
          }

          if (isCancelled()) {
            if (sessionId) {
              await cancelSession(sessionId);
            }
            throw new Error('Cancelled by user');
          }

          await postTurnApprovalEvents(sessionId, currentTurnId, approvalEvents);

          let resubscribeSuccess = false;
          for (let attempt = 1; attempt <= 2; attempt++) {
            try {
              stream = await subscribeTurnStream(sessionId, currentTurnId, lastSeenEventId);
              resubscribeSuccess = true;
              break;
            } catch (subErr: unknown) {
              if (attempt === 1) {
                channel.appendLine('[subscribeToTurn] transient connection error; retrying in 1000ms...');
                await new Promise((resolve) => setTimeout(resolve, 1000));
              } else {
                const msg = subErr instanceof Error ? subErr.message : String(subErr);
                channel.appendLine(`\n[subscribeToTurn error after retry]: ${msg}`);
                throw subErr;
              }
            }
          }

          if (!resubscribeSuccess) {
            throw new Error('Failed to resume turn stream.');
          }
        }

        if (finalTurnStatus === 'error') {
          uiEventBus.emit({
            type: 'runDone',
            generation: runGeneration,
            status: 'error',
            errorMessage: finalErrorMessage || 'Turn failed',
          });
          return { status: 'error', errorMessage: finalErrorMessage || 'Turn failed' };
        }

        uiEventBus.emit({
          type: 'runDone',
          generation: runGeneration,
          status: 'done',
        });
        channel.appendLine(`\n\n[Turn status: ${finalTurnStatus || 'done'}]`);
        return { status: finalTurnStatus || 'done' };
      },
      {
        onFallback: async (fromModel, toModel, reason) => {
          uiEventBus.emit({
            type: 'modelFallback',
            generation: runGeneration,
            fromModel,
            toModel,
            reason,
          });
          vscode.window.showWarningMessage(
            `ForgePilot: Model "${fromModel}" failed (${reason}). Falling back to "${toModel}"...`
          );
          channel.appendLine(
            `\n>>> [Automatic Model Fallback] Model "${fromModel}" failed (${reason}). Retrying on "${toModel}"...\n`
          );
        },
        isCancelled,
        log: (msg) => channel.appendLine(msg),
      }
    );
  } catch (err: unknown) {
    if (isCancelled()) {
      uiEventBus.emit({
        type: 'runDone',
        generation: runGeneration,
        status: 'cancelled',
      });
      channel.appendLine('\n\n[Turn status: cancelled]');
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    uiEventBus.emit({
      type: 'runDone',
      generation: runGeneration,
      status: 'error',
      errorMessage: message,
    });
    channel.appendLine(`\n\n[Error: ${message}]`);
    vscode.window.showErrorMessage(`ForgePilot: ${message}`);
  } finally {
    if (activeCancelCallback) {
      activeCancelCallback = null;
    }
    setActiveSessionId(null);
    await vscode.commands.executeCommand('setContext', 'forgepilot.running', false);
  }
}

/**
 * Runs the "ForgePilot: Ask Agent" flow with approval-driven review loop and automatic model fallback.
 */
export async function runAgent(
  channel: vscode.OutputChannel,
  runGeneration: number,
  isCurrentGen: () => boolean,
  setActiveSessionId: (id: string | null) => void
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('ForgePilot: Open a folder first.');
    return;
  }

  const prompt = await vscode.window.showInputBox({
    prompt: 'Ask ForgePilot agent',
    placeHolder: 'e.g. Find all exports in src and explain what each one does',
  });
  if (!prompt) {
    return;
  }

  await executeAgentTurnWithFallback({
    channel,
    prompt,
    workspaceRoot,
    runTitle: 'ForgePilot: Ask Agent',
    runGeneration,
    isCurrentGen,
    setActiveSessionId,
  });
}
