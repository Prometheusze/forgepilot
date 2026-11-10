// src/utils/undoStack.ts
import * as vscode from 'vscode';

export interface UndoEntry {
  filePath: string;
  beforeContent: string;   // full file content before the applied hunk
  afterContent: string;    // content after the hunk (for reference)
  timestamp: number;
  description: string;
}

export class UndoStack {
  private static stack: UndoEntry[] = [];

  static push(entry: UndoEntry) {
    this.stack.push(entry);
  }

  static pop(): UndoEntry | undefined {
    return this.stack.pop();
  }

  static async undoLast(): Promise<void> {
    const entry = this.pop();
    if (!entry) {
      vscode.window.showInformationMessage('🔙 No edit to undo');
      return;
    }
    const doc = await vscode.workspace.openTextDocument(entry.filePath);
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      0,
      0,
      doc.lineCount,
      doc.lineAt(doc.lineCount - 1).text.length
    );
    edit.replace(doc.uri, fullRange, entry.beforeContent);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    vscode.window.showInformationMessage(
      `🔙 Reverted edit in ${vscode.path.basename(entry.filePath)}`
    );
  }
}
