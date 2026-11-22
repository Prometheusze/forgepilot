// src/review/undo.ts
import * as vscode from 'vscode';

export interface UndoRecord {
  uri: vscode.Uri;
  beforeText: string;
  afterText: string;
  wasSaved: boolean;
  label: string;
}

const undoStack: UndoRecord[] = [];
let statusBarItem: vscode.StatusBarItem | null = null;

/**
 * Initializes and registers the ForgePilot Undo status bar item.
 */
export function initUndoStatusBar(context: vscode.ExtensionContext): vscode.StatusBarItem {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBarItem.command = 'forgepilot.undoLastEdit';
  statusBarItem.tooltip = 'Revert the most recent applied edit';
  updateStatusBar();
  context.subscriptions.push(statusBarItem);
  return statusBarItem;
}

function updateStatusBar(): void {
  if (!statusBarItem) {
    return;
  }
  const count = undoStack.length;
  if (count > 0) {
    statusBarItem.text = `$(arrow-undo) ForgePilot Undo (${count})`;
    statusBarItem.show();
  } else {
    statusBarItem.hide();
  }
}

/**
 * Pushes a new undo record onto the stack and updates the status bar item.
 */
export function pushUndoRecord(record: UndoRecord): void {
  undoStack.push(record);
  updateStatusBar();
}

/**
 * Handles the forgepilot.undoLastEdit command.
 * Pops the last record; if current text !== afterText, refuses with a warning
 * and keeps the record on the stack. Otherwise, restores beforeText atomically.
 */
export async function undoLastEdit(): Promise<void> {
  if (undoStack.length === 0) {
    vscode.window.showInformationMessage('ForgePilot: Nothing to undo');
    return;
  }

  const record = undoStack[undoStack.length - 1];

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(record.uri);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    vscode.window.showErrorMessage(`ForgePilot: Failed to open document for undo: ${msg}`);
    return;
  }

  const currentText = doc.getText();
  if (currentText !== record.afterText) {
    vscode.window.showWarningMessage('file changed since the edit; undo refused to protect your changes');
    return;
  }

  // File matches afterText, safe to pop
  undoStack.pop();
  updateStatusBar();

  const fullRange = new vscode.Range(
    doc.positionAt(0),
    doc.positionAt(currentText.length)
  );

  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, fullRange, record.beforeText);

  const success = await vscode.workspace.applyEdit(edit);
  if (!success) {
    // If edit failed, push record back so user doesn't lose undo state
    undoStack.push(record);
    updateStatusBar();
    vscode.window.showErrorMessage(`ForgePilot: Failed to apply undo edit to ${record.label}`);
    return;
  }

  if (record.wasSaved) {
    await doc.save();
  }

  vscode.window.showInformationMessage(`ForgePilot: Reverted edit in ${record.label}`);
}
