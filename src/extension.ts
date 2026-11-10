// src/extension.ts
import * as vscode from 'vscode';
import { HunkManager } from './diff/hunkManager';
import { UndoStack } from './utils/undoStack';
import { InlineEditController } from './inline/inlineEditController';

export function activate(context: vscode.ExtensionContext) {
  const hunkManager = new HunkManager(context);
  let abortController: AbortController | null = null;

  // Inline edit command (Cmd+K / Ctrl+K)
  context.subscriptions.push(
    vscode.commands.registerCommand('forgepilot.inlineEdit', async () => {
      abortController = new AbortController();
      await InlineEditController.run({
        hunkManager,
        abortSignal: abortController.signal,
      });
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

  // Cancel / Escape command
  context.subscriptions.push(
    vscode.commands.registerCommand('forgepilot.cancelRun', () => {
      if (abortController) {
        abortController.abort();
        abortController = null;
        vscode.window.showInformationMessage('🛑 TrueForge run cancelled');
      }
    })
  );

  // Status‑bar button for undo
  const undoItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  undoItem.command = 'forgepilot.undoLastEdit';
  undoItem.text = '$(arrow-undo) Undo Last Edit';
  undoItem.tooltip = 'Revert the most recent applied edit';
  undoItem.show();
  context.subscriptions.push(undoItem);
}

export function deactivate() {}
