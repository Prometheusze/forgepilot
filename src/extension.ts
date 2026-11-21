// src/extension.ts
import * as vscode from 'vscode';
import { HunkManager } from './diff/hunkManager.js';
import { UndoStack } from './utils/undoStack.js';
import { getForgePilotConfig } from './trueforge/config.js';
import { createSession, streamTurn, cancelSession } from './trueforge/session.js';
import { runAgent } from './agent/runAgent.js';
import { disposeMcpServer } from './mcp/server.js';

export function activate(context: vscode.ExtensionContext) {
  const hunkManager = new HunkManager(context);
  let activeSessionId: string | null = null;
  let runGeneration = 0;
  let outputChannel: vscode.OutputChannel | null = null;

  function getChannel(): vscode.OutputChannel {
    if (!outputChannel) {
      outputChannel = vscode.window.createOutputChannel('ForgePilot');
    }
    return outputChannel;
  }

  // Smoke test command: creates a session, streams model output, handles errors and cancellation
  context.subscriptions.push(
    vscode.commands.registerCommand('forgepilot.smokeTest', async () => {
      const config = getForgePilotConfig();
      if (!config.models || config.models.length === 0) {
        vscode.window.showErrorMessage(
          'ForgePilot: No models configured. Please set "forgepilot.models" in VS Code settings.'
        );
        return;
      }

      const prompt = await vscode.window.showInputBox({
        prompt: 'Enter prompt for TrueForge smoke test',
        placeHolder: 'e.g. Say hello and explain recursion in one sentence',
      });
      if (!prompt) {
        return;
      }

      const currentGen = ++runGeneration;
      const channel = getChannel();
      channel.show(true);
      channel.appendLine(`\n>>> TrueForge Smoke Test (Run #${currentGen})`);
      channel.appendLine(`Model: ${config.models[0]}`);
      channel.appendLine(`Prompt: ${prompt}\n`);

      await vscode.commands.executeCommand('setContext', 'forgepilot.running', true);

      try {
        const sessionId = await createSession(config.models[0]);
        if (currentGen !== runGeneration) {
          return;
        }
        activeSessionId = sessionId;

        const turnResult = await streamTurn(sessionId, prompt, (delta) => {
          if (currentGen === runGeneration) {
            channel.append(delta);
          }
        });

        if (currentGen === runGeneration) {
          if (turnResult.status === 'cancelled') {
            channel.appendLine('\n\ncancelled');
          } else if (turnResult.status === 'error') {
            const errorMsg = turnResult.errorMessage || 'Turn ended with error';
            channel.appendLine(`\n\n[Turn error: ${errorMsg}]`);
            vscode.window.showErrorMessage(`ForgePilot: Turn error: ${errorMsg}`);
          } else {
            channel.appendLine(`\n\n[Turn status: ${turnResult.status}]`);
          }
        }
      } catch (err: unknown) {
        if (currentGen === runGeneration) {
          const message = err instanceof Error ? err.message : String(err);
          channel.appendLine(`\n\n[Error: ${message}]`);
          vscode.window.showErrorMessage(`ForgePilot: ${message}`);
        }
      } finally {
        if (currentGen === runGeneration) {
          activeSessionId = null;
          await vscode.commands.executeCommand('setContext', 'forgepilot.running', false);
        }
      }
    })
  );

  // Ask Agent command: runs agent session connected to local MCP server
  context.subscriptions.push(
    vscode.commands.registerCommand('forgepilot.askAgent', async () => {
      const currentGen = ++runGeneration;
      const channel = getChannel();
      await runAgent(
        channel,
        currentGen,
        () => currentGen === runGeneration,
        (id) => {
          activeSessionId = id;
        }
      );
    })
  );

  // Inline edit command (Ctrl+Alt+K / Cmd+Alt+K)
  context.subscriptions.push(
    vscode.commands.registerCommand('forgepilot.inlineEdit', async () => {
      vscode.window.showWarningMessage('ForgePilot: inline edit is not implemented yet');
    })
  );

  // Accept / reject hunk commands
  context.subscriptions.push(
    vscode.commands.registerCommand('forgepilot.acceptHunk', async (editId: string, hunkId: string) => {
      await hunkManager.acceptHunk(editId, hunkId);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('forgepilot.rejectHunk', async (editId: string, hunkId: string) => {
      await hunkManager.rejectHunk(editId, hunkId);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('forgepilot.acceptAllInFile', async (editId: string, filePath: string) => {
      await hunkManager.acceptAllInFile(editId, filePath);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('forgepilot.rejectAllInFile', async (editId: string, filePath: string) => {
      await hunkManager.rejectAllInFile(editId, filePath);
    })
  );

  // Undo command
  context.subscriptions.push(
    vscode.commands.registerCommand('forgepilot.undoLastEdit', async () => {
      await UndoStack.undoLast();
    })
  );

  // Cancel / Escape command: calls cancelSession for the active run
  context.subscriptions.push(
    vscode.commands.registerCommand('forgepilot.cancelRun', async () => {
      if (!activeSessionId) {
        return;
      }
      const sessionId = activeSessionId;
      const channel = getChannel();
      try {
        await cancelSession(sessionId);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        channel.appendLine(`\n[Cancel error: ${message}]`);
      }
    })
  );

  // Status-bar button for undo
  const undoItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  undoItem.command = 'forgepilot.undoLastEdit';
  undoItem.text = '$(arrow-undo) Undo Last Edit';
  undoItem.tooltip = 'Revert the most recent applied edit';
  undoItem.show();
  context.subscriptions.push(undoItem);
}

export function deactivate() {
  void disposeMcpServer().catch(() => {});
}
