// src/agent/runAgent.ts
import * as vscode from 'vscode';
import { getForgePilotConfig } from '../trueforge/config.js';
import { getOrStartMcpServer } from '../mcp/server.js';
import { registerMcpServer, createAgentSession, streamTurn } from '../trueforge/session.js';

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
 * Runs the "ForgePilot: Ask Agent" flow:
 * 1. Validates that a workspace folder is open.
 * 2. Validates configuration.
 * 3. Prompts user for instructions.
 * 4. Lazily starts MCP server with the explicit workspace root and registers with TrueForge.
 * 5. Creates agent session and streams turn events into the Output channel.
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

  channel.show(true);
  channel.appendLine(`\n>>> ForgePilot: Ask Agent (Run #${runGeneration})`);
  channel.appendLine(`Workspace: ${workspaceRoot}`);
  channel.appendLine(`Model: ${config.models[0]}`);
  channel.appendLine(`Prompt: ${prompt}\n`);

  await vscode.commands.executeCommand('setContext', 'forgepilot.running', true);

  try {
    // 1. Ensure local MCP server is running with the explicit workspace root
    const mcp = await getOrStartMcpServer(config.mcpPort, workspaceRoot);
    if (!isCurrentGen()) {
      return;
    }

    // 2. Register MCP server with TrueForge
    channel.appendLine(`[mcp.register] registering forgepilot-editor at ${mcp.redactedUrl}...`);
    const regResult = await registerMcpServer(config.baseUrl, mcp.port, mcp.token);
    if (!isCurrentGen()) {
      return;
    }
    channel.appendLine(`[mcp.register] registration status: ${regResult.status} OK\n`);

    // 3. Create TrueForge session with the agent spec
    const sessionId = await createAgentSession(config.models[0]);
    if (!isCurrentGen()) {
      return;
    }
    setActiveSessionId(sessionId);

    // 4. Stream turn: text deltas and non-delta events live
    const turnResult = await streamTurn(
      sessionId,
      prompt,
      (delta) => {
        if (isCurrentGen()) {
          channel.append(delta);
        }
      },
      undefined,
      (event) => {
        if (isCurrentGen()) {
          const summary = formatEventSummary(event);
          if (summary) {
            channel.appendLine(`\n${summary}`);
          }
        }
      }
    );

    if (isCurrentGen()) {
      if (turnResult.status === 'cancelled') {
        channel.appendLine('\n\n[Turn status: cancelled]');
      } else if (turnResult.status === 'error') {
        const errorMsg = turnResult.errorMessage || 'Turn ended with error';
        channel.appendLine(`\n\n[Turn error: ${errorMsg}]`);
        vscode.window.showErrorMessage(`ForgePilot: Turn error: ${errorMsg}`);
      } else {
        channel.appendLine(`\n\n[Turn status: ${turnResult.status}]`);
      }
    }
  } catch (err: unknown) {
    if (isCurrentGen()) {
      const message = err instanceof Error ? err.message : String(err);
      channel.appendLine(`\n\n[Error: ${message}]`);
      vscode.window.showErrorMessage(`ForgePilot: ${message}`);
    }
  } finally {
    if (isCurrentGen()) {
      setActiveSessionId(null);
      await vscode.commands.executeCommand('setContext', 'forgepilot.running', false);
    }
  }
}
