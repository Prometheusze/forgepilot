// src/extension.ts
import * as vscode from 'vscode';
import * as path from 'node:path';
import { getForgePilotConfig } from './trueforge/config.js';
import { createSession, streamTurn, cancelSession } from './trueforge/session.js';
import { runAgent, abortActiveAgentRun } from './agent/runAgent.js';
import { disposeMcpServer } from './mcp/server.js';
import { initUndoStatusBar, undoLastEdit } from './review/undo.js';
import { registerDiffProvider, reviewProposal, cancelActiveReview } from './review/reviewUi.js';
import { parseProposeEditArgs } from './review/proposal.js';

export function activate(context: vscode.ExtensionContext) {
  registerDiffProvider(context);
  initUndoStatusBar(context);

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
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      const channel = getChannel();
      channel.appendLine(`Workspace: ${workspaceRoot ?? 'none'}`);

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
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      const channel = getChannel();
      channel.appendLine(`Workspace: ${workspaceRoot ?? 'none'}`);

      const currentGen = ++runGeneration;
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

  // Undo command backed by new undo pipeline
  context.subscriptions.push(
    vscode.commands.registerCommand('forgepilot.undoLastEdit', async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      const channel = getChannel();
      channel.appendLine(`Workspace: ${workspaceRoot ?? 'none'}`);
      await undoLastEdit();
    })
  );

  // Dev-only command to review a sample edit without model/TrueForge calls
  context.subscriptions.push(
    vscode.commands.registerCommand('forgepilot.devReviewSample', async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
      const channel = getChannel();
      channel.show(true);
      channel.appendLine('\n>>> ForgePilot (dev): Review Sample Edit');
      if (!workspaceRoot) {
        channel.appendLine('Error: No workspace folder open.');
        vscode.window.showErrorMessage('ForgePilot: Open a folder first.');
        return;
      }
      channel.appendLine(`Workspace: ${workspaceRoot}`);

      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor || activeEditor.document.isUntitled) {
        vscode.window.showErrorMessage('ForgePilot: No active file in editor.');
        channel.appendLine('Error: No active file in editor.');
        return;
      }

      const filePath = activeEditor.document.uri.fsPath;
      channel.appendLine(`Target file: ${filePath}`);

      const input = await vscode.window.showInputBox({
        title: 'ForgePilot (dev): Review Sample Edit',
        prompt: 'Enter JSON array of edits: [{"old_text": "...", "new_text": "..."}]',
        placeHolder: '[{"old_text": "target", "new_text": "replacement"}]',
        ignoreFocusOut: true,
      });

      if (!input) {
        channel.appendLine('Cancelled: No input provided.');
        return;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(input);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(`ForgePilot: Invalid JSON: ${msg}`);
        channel.appendLine(`Invalid JSON: ${msg}`);
        return;
      }

      const parseResult = parseProposeEditArgs({
        path: filePath,
        edits: parsedJson,
        explanation: 'Dev sample edit',
      });

      if (!parseResult.ok) {
        vscode.window.showErrorMessage(`ForgePilot: ${parseResult.error}`);
        channel.appendLine(`Validation error: ${parseResult.error}`);
        return;
      }

      channel.appendLine(`Initiating review for ${parseResult.args.edits.length} edit(s)...`);
      const outcome = await reviewProposal(parseResult.args, workspaceRoot, () => false);
      channel.appendLine(`Review outcome: ${JSON.stringify(outcome, null, 2)}`);

      if (outcome.kind === 'applied') {
        vscode.window.showInformationMessage(
          `ForgePilot: Applied ${outcome.acceptedHunkIds.length}/${outcome.totalHunks} hunks to ${path.basename(outcome.path)} (saved: ${outcome.saved})`
        );
      } else if (outcome.kind === 'rejected') {
        vscode.window.showInformationMessage(`ForgePilot: Edits rejected: ${outcome.reason}`);
      } else if (outcome.kind === 'cancelled') {
        vscode.window.showInformationMessage(`ForgePilot: Review cancelled: ${outcome.reason}`);
      } else if (outcome.kind === 'stale') {
        vscode.window.showWarningMessage(`ForgePilot: Review stale: ${outcome.reason}`);
      } else if (outcome.kind === 'invalid') {
        vscode.window.showErrorMessage(`ForgePilot: Invalid proposal: ${outcome.reason}`);
      }
    })
  );

  // Cancel / Escape command: cancels active review and calls cancelSession for the active run
  context.subscriptions.push(
    vscode.commands.registerCommand('forgepilot.cancelRun', async () => {
      cancelActiveReview();
      abortActiveAgentRun();
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
}

export function deactivate() {
  cancelActiveReview();
  void disposeMcpServer().catch(() => {});
}
