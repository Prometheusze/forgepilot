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
import { parseProposeEditArgs, canonicalKey } from '../review/proposal.js';
import { reviewProposal, cancelActiveReview } from '../review/reviewUi.js';
import { put as putDecision } from '../review/decisions.js';
import { resolveToolCall } from './toolResolve.js';

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

/**
 * Runs the "ForgePilot: Ask Agent" flow with approval-driven review loop:
 * 1. Validates that a workspace folder is open.
 * 2. Validates configuration.
 * 3. Prompts user for instructions.
 * 4. Lazily starts MCP server with the explicit workspace root and registers with TrueForge.
 * 5. Creates agent session with require_approval_for_tools for propose_edit.
 * 6. Streams turn events in a loop, pausing on tool.approval_required, executing
 *    reviewProposal, and sending user.tool_approval events before resuming.
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

  const config = getForgePilotConfig();
  if (!config.models || config.models.length === 0) {
    vscode.window.showErrorMessage(
      'ForgePilot: No models configured. Please set "forgepilot.models" in VS Code settings.'
    );
    return;
  }

  const prompt = await vscode.window.showInputBox({
    prompt: 'Ask ForgePilot agent',
    placeHolder: 'e.g. Find all exports in src and explain what each one does',
  });
  if (!prompt) {
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

  channel.show(true);
  channel.appendLine(`\n>>> ForgePilot: Ask Agent (Run #${runGeneration})`);
  channel.appendLine(`Workspace: ${workspaceRoot}`);
  channel.appendLine(`Model: ${config.models[0]}`);
  channel.appendLine(`Prompt: ${prompt}\n`);

  await vscode.commands.executeCommand('setContext', 'forgepilot.running', true);

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

  try {
    // 1. Ensure local MCP server is running with the explicit workspace root
    const mcp = await getOrStartMcpServer(config.mcpPort, workspaceRoot);
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

    // 3. Create TrueForge session with the agent spec
    sessionId = await createAgentSession(config.models[0]);
    if (isCancelled()) {
      return;
    }
    setActiveSessionId(sessionId);

    // 4. Start turn stream
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
          }

          if (event.type === 'turn.update' && event.state?.status === 'paused') {
            paused = true;
            break; // Exit inner stream loop to handle pending approvals
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

      // Hang protection: stream closed without turn.done and without paused state
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
            vscode.window.showErrorMessage(
              `ForgePilot: Turn terminated unexpectedly with state: ${status}${msg}`
            );
          } catch (fetchErr: unknown) {
            const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
            channel.appendLine(`[Failed to query turn state]: ${msg}`);
            vscode.window.showErrorMessage(
              `ForgePilot: Turn stream closed unexpectedly and status query failed: ${msg}`
            );
          }
        } else {
          channel.appendLine('\n[Stream closed prematurely before turn initialization]');
          vscode.window.showErrorMessage('ForgePilot: Turn stream closed prematurely.');
        }
        return;
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

        // Call resolveToolCall FIRST
        let resolved = await resolveToolCall(
          { id: pending.id, sourceEventId: pending.sourceEventId ?? '' },
          listEvents
        );

        // Keep existing streamed-tool-call buffer only as secondary fallback
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
          } catch (jsonErr: unknown) {
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
            return;
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
          }
        } else {
          // Identified non-propose_edit tools keep modal Allow/Deny (default deny)
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
          }
        }
      }

      if (isCancelled()) {
        if (sessionId) {
          await cancelSession(sessionId);
        }
        return;
      }

      // Post approval events
      await postTurnApprovalEvents(sessionId, currentTurnId, approvalEvents);

      // Resume reading turn stream with retry on transient network failure
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
            vscode.window.showErrorMessage(`ForgePilot: Failed to resume turn stream: ${msg}`);
            return;
          }
        }
      }

      if (!resubscribeSuccess) {
        return;
      }
    }

    if (isCancelled()) {
      channel.appendLine('\n\n[Turn status: cancelled]');
    } else if (finalTurnStatus === 'error') {
      const errorMsg = finalErrorMessage || 'Turn ended with error';
      channel.appendLine(`\n\n[Turn error: ${errorMsg}]`);
      vscode.window.showErrorMessage(`ForgePilot: Turn error: ${errorMsg}`);
    } else if (finalTurnStatus) {
      channel.appendLine(`\n\n[Turn status: ${finalTurnStatus}]`);
    }
  } catch (err: unknown) {
    if (isCancelled()) {
      channel.appendLine('\n\n[Turn status: cancelled]');
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
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
