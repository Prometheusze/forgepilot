// src/diff/hunkManager.ts
import * as vscode from 'vscode';
import { UndoStack, UndoEntry } from '../utils/undoStack';
import { TrueForgeClient } from '../trueforge/client'; // thin wrapper around @truefoundry/trueforge-sdk

export interface DiffHunk {
  id: string;               // UUID
  filePath: string;         // absolute path
  startLine: number;        // 1‑based
  endLine: number;          // inclusive
  originalLines: string[];  // as‑is from file
  newLines: string[];       // proposed replacement
  status: 'pending' | 'accepted' | 'rejected';
  rationale?: string;       // from the tool call
}

/**
 * Parses a unified diff (the format emitted by `git diff –unified=0` or
 * by TrueForge’s `propose_edit` tool) into an array of `DiffHunk`s.
 *
 * Example chunk header:
 *   @@ -10,5 +10,7 @@
 */
export function parseUnifiedDiff(unifiedDiff: string, filePath: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const lines = unifiedDiff.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const header = lines[i].match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
    if (!header) { i++; continue; }

    const [, oldStartStr, oldCountStr, newStartStr, newCountStr] = header;
    const oldStart = Number(oldStartStr);
    const oldCount = oldCountStr ? Number(oldCountStr) : 1;
    const newStart = Number(newStartStr);
    const newCount = newCountStr ? Number(newCountStr) : 1;

    const originalLines: string[] = [];
    const newLines: string[] = [];

    i++; // move past header
    while (i < lines.length && !lines[i].startsWith('@@')) {
      const line = lines[i];
      if (line.startsWith('-')) originalLines.push(line.slice(1));
      else if (line.startsWith('+')) newLines.push(line.slice(1));
      else if (line.startsWith(' ')) {
        // context line – appears in both original & new
        originalLines.push(line.slice(1));
        newLines.push(line.slice(1));
      }
      i++;
    }

    const hunk: DiffHunk = {
      id: crypto.randomUUID(),
      filePath,
      startLine: oldStart,
      endLine: oldStart + originalLines.length - 1,
      originalLines,
      newLines,
      status: 'pending',
    };
    hunks.push(hunk);
  }
  return hunks;
}

/**
 * Central manager for all staged edits in a turn.
 */
export class HunkManager {
  /** editId → list of hunks for that edit (one TrueForge turn) */
  private staged = new Map<string, DiffHunk[]>();
  private decorations = new Map<string, vscode.TextEditorDecorationType>();
  private codeLensProvider: vscode.CodeLensProvider;

  constructor(private context: vscode.ExtensionContext) {
    this.codeLensProvider = new InlineHunkCodeLensProvider(this);
    this.context.subscriptions.push(
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this.codeLensProvider)
    );
  }

  /** Stage a new edit coming from `propose_edit` */
  stageEdit(editId: string, filePath: string, unifiedDiff: string, rationale?: string): void {
    const hunks = parseUnifiedDiff(unifiedDiff, filePath).map(h => ({ ...h, rationale }));
    this.staged.set(editId, hunks);
    this.applyDecorations(editId);
    // expose to webview via workspaceState (simple approach)
    this.context.workspaceState.update(`hunks:${editId}`, hunks);
  }

  /** Accept a single hunk */
  async acceptHunk(editId: string, hunkId: string): Promise<void> {
    const hunk = this.findHunk(editId, hunkId);
    if (!hunk) return;
    const doc = await vscode.workspace.openTextDocument(hunk.filePath);
    const edit = new vscode.WorkspaceEdit();
    const range = new vscode.Range(
      hunk.startLine - 1,
      0,
      hunk.endLine,
      doc.lineAt(hunk.endLine - 1).text.length
    );
    const before = doc.getText();
    edit.replace(doc.uri, range, hunk.newLines.join('\n'));
    await vscode.workspace.applyEdit(edit);
    await doc.save();

    // push undo entry
    UndoStack.push({
      filePath: hunk.filePath,
      beforeContent: before,
      afterContent: hunk.newLines.join('\n'),
      timestamp: Date.now(),
      description: hunk.rationale ?? 'Proposed edit',
    });

    hunk.status = 'accepted';
    this.refreshDecorations(editId);
    await this.maybeApproveEdit(editId);
  }

  /** Reject a single hunk – simply discard it */
  async rejectHunk(editId: string, hunkId: string): Promise<void> {
    const hunk = this.findHunk(editId, hunkId);
    if (!hunk) return;
    hunk.status = 'rejected';
    this.refreshDecorations(editId);
    await this.maybeApproveEdit(editId);
  }

  /** Accept / reject all hunks in a file */
  async acceptAllInFile(editId: string, filePath: string): Promise<void> {
    const hunks = this.staged.get(editId) ?? [];
    for (const hunk of hunks.filter(h => h.filePath === filePath && h.status === 'pending')) {
      await this.acceptHunk(editId, hunk.id);
    }
  }
  async rejectAllInFile(editId: string, filePath: string): Promise<void> {
    const hunks = this.staged.get(editId) ?? [];
    for (const hunk of hunks.filter(h => h.filePath === filePath && h.status === 'pending')) {
      await this.rejectHunk(editId, hunk.id);
    }
  }

  /** Clear all staged data when a turn finishes or is cancelled */
  clearEdit(editId: string): void {
    this.staged.delete(editId);
    this.clearDecorations(editId);
    this.context.workspaceState.update(`hunks:${editId}`, undefined);
  }

  /** ----------- internal helpers ------------ */

  private findHunk(editId: string, hunkId: string): DiffHunk | undefined {
    const hunks = this.staged.get(editId);
    return hunks?.find(h => h.id === hunkId);
  }

  /** Decorations for pending/accepted/rejected hunks */
  private applyDecorations(editId: string) {
    const hunks = this.staged.get(editId) ?? [];
    for (const hunk of hunks) {
      const doc = vscode.workspace.textDocuments.find(d => d.fileName === hunk.filePath);
      if (!doc) continue;
      const editor = vscode.window.visibleTextEditors.find(e => e.document === doc);
      if (!editor) continue;

      const range = new vscode.Range(
        hunk.startLine - 1,
        0,
        hunk.endLine,
        doc.lineAt(hunk.endLine - 1).text.length
      );

      const decoType = vscode.window.createTextEditorDecorationType({
        backgroundColor:
          hunk.status === 'pending' ? 'rgba(255,200,200,0.3)' :
          hunk.status === 'accepted' ? 'rgba(200,255,200,0.3)' :
          'rgba(200,200,200,0.2)',
        isWholeLine: true,
      });
      editor.setDecorations(decoType, [range]);
      this.decorations.set(`${editId}:${hunk.id}`, decoType);
    }
  }

  private refreshDecorations(editId: string) {
    this.clearDecorations(editId);
    this.applyDecorations(editId);
  }

  private clearDecorations(editId: string) {
    for (const [key, deco] of this.decorations.entries()) {
      if (key.startsWith(`${editId}:`)) {
        deco.dispose();
        this.decorations.delete(key);
      }
    }
  }

  /** When all hunks resolved, inform TrueForge about approval */
  private async maybeApproveEdit(editId: string) {
    const hunks = this.staged.get(editId);
    if (!hunks) return;
    const allDone = hunks.every(h => h.status !== 'pending');
    if (!allDone) return;
    const approved = hunks.some(h => h.status === 'accepted');
    // send approval via SDK (client must be initialised elsewhere)
    try {
      await TrueForgeClient.instance.tools.approve({ editId, approved });
    } catch (e) {
      console.error('Failed to send tool approval', e);
    }
    // finally clear UI artefacts
    this.clearEdit(editId);
  }
}

/* ------------------------------------------------------------------ */
/* CodeLens provider – adds per‑hunk UI buttons directly in the editor */
class InlineHunkCodeLensProvider implements vscode.CodeLensProvider {
  constructor(private manager: HunkManager) {}

  provideCodeLenses(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): vscode.CodeLens[] {
    const lenses: vscode.CodeLens[] = [];
    for (const [editId, hunks] of this.manager['staged'].entries()) {
      for (const hunk of hunks) {
        if (hunk.filePath !== document.fileName || hunk.status !== 'pending') continue;
        const range = new vscode.Range(hunk.startLine - 1, 0, hunk.startLine - 1, 0);
        lenses.push(
          new vscode.CodeLens(range, {
            title: '✓ Accept',
            command: 'forgepilot.acceptHunk',
            arguments: [editId, hunk.id],
          })
        );
        lenses.push(
          new vscode.CodeLens(range, {
            title: '✗ Reject',
            command: 'forgepilot.rejectHunk',
            arguments: [editId, hunk.id],
          })
        );
      }
    }
    return lenses;
  }
}
