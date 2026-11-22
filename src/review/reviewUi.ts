// src/review/reviewUi.ts
import * as vscode from 'vscode';
import * as path from 'node:path';
import { validateWorkspacePath } from '../mcp/workspaceGuard.js';
import { applySelectedHunks, hunkSummary } from '../diff/patch.js';
import { buildProposal, computeContentHash, ProposeEditArgs } from './proposal.js';
import { pushUndoRecord } from './undo.js';

export type ReviewOutcome =
  | {
      kind: 'applied';
      path: string;
      acceptedHunkIds: number[];
      rejectedHunkIds: number[];
      totalHunks: number;
      saved: boolean;
    }
  | { kind: 'rejected'; reason: string }
  | { kind: 'invalid'; reason: string }
  | { kind: 'stale'; reason: string }
  | { kind: 'cancelled'; reason: string };

class ForgePilotDiffContentProvider implements vscode.TextDocumentContentProvider {
  private contents = new Map<string, string>();
  private onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.onDidChangeEmitter.fire(uri);
  }

  delete(uri: vscode.Uri): void {
    this.contents.delete(uri.toString());
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  dispose(): void {
    this.contents.clear();
    this.onDidChangeEmitter.dispose();
  }
}

const diffContentProvider = new ForgePilotDiffContentProvider();
let providerRegistration: vscode.Disposable | null = null;

export function registerDiffProvider(context: vscode.ExtensionContext): void {
  if (!providerRegistration) {
    providerRegistration = vscode.workspace.registerTextDocumentContentProvider(
      'forgepilot-diff',
      diffContentProvider
    );
    context.subscriptions.push(providerRegistration);
  }
}

let activeCancellationTokenSource: vscode.CancellationTokenSource | null = null;
let isReviewExplicitlyCancelled = false;

/**
 * Closes any open review prompt; the pending reviewProposal resolves as 'cancelled';
 * nothing is applied.
 */
export function cancelActiveReview(): void {
  isReviewExplicitlyCancelled = true;
  if (activeCancellationTokenSource) {
    activeCancellationTokenSource.cancel();
  }
}

/**
 * Interactive per-hunk review and atomic apply pipeline for AI-proposed edits.
 */
export async function reviewProposal(
  args: ProposeEditArgs,
  workspaceRoot: string,
  isCancelled: () => boolean
): Promise<ReviewOutcome> {
  // 1. Resolve args.path via workspaceGuard
  const guard = validateWorkspacePath(args.path, workspaceRoot);
  if (!guard.ok) {
    return { kind: 'invalid', reason: guard.error };
  }
  const fullPath = guard.fullPath;
  const relPath = guard.relativePath;

  // 2. Open document in workspace
  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(fullPath);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { kind: 'invalid', reason: `Failed to open document: ${msg}` };
  }

  const initialVersion = doc.version;
  const baseRaw = doc.getText();
  const wasDirty = doc.isDirty;

  // 3. Build proposal (pure diff/patch computation)
  const proposal = buildProposal(baseRaw, args, initialVersion);
  if (!proposal.ok) {
    return { kind: 'invalid', reason: proposal.error };
  }
  const { baseText, baseHash, hunks } = proposal;

  const reviewId = `rev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const registeredUris: vscode.Uri[] = [];
  const cts = new vscode.CancellationTokenSource();
  activeCancellationTokenSource = cts;
  isReviewExplicitlyCancelled = false;

  const checkCancelled = () =>
    isCancelled() || isReviewExplicitlyCancelled || cts.token.isCancellationRequested;

  const acceptedIds: number[] = [];
  const rejectedIds: number[] = [];

  try {
    const fileName = path.basename(fullPath);

    // 4. For each hunk i (0-based) in order
    for (let i = 0; i < hunks.length; i++) {
      if (checkCancelled()) {
        return { kind: 'cancelled', reason: 'Review cancelled' };
      }

      const hunk = hunks[i];
      const leftUri = vscode.Uri.parse(
        `forgepilot-diff:/${reviewId}/hunk-${hunk.id}-left/${fileName}`
      );
      const rightUri = vscode.Uri.parse(
        `forgepilot-diff:/${reviewId}/hunk-${hunk.id}-right/${fileName}`
      );

      registeredUris.push(leftUri, rightUri);
      diffContentProvider.set(leftUri, baseText);
      diffContentProvider.set(rightUri, applySelectedHunks(baseText, hunks, [hunk.id]));

      const diffTitle = `ForgePilot: Hunk ${i + 1}/${hunks.length} (${fileName})`;

      try {
        await vscode.commands.executeCommand(
          'vscode.diff',
          leftUri,
          rightUri,
          diffTitle,
          { preview: true, preserveFocus: true }
        );
      } catch {
        // Continue even if diff editor fails to open
      }

      if (checkCancelled()) {
        return { kind: 'cancelled', reason: 'Review cancelled' };
      }

      type Action = 'accept' | 'reject' | 'accept_all' | 'reject_all' | 'cancel';
      interface HunkPickItem extends vscode.QuickPickItem {
        action: Action;
      }

      const items: HunkPickItem[] = [
        { label: 'Accept this hunk', description: 'Apply this change', action: 'accept' },
        { label: 'Reject this hunk', description: 'Skip this change', action: 'reject' },
        {
          label: 'Accept this and all remaining',
          description: 'Accept this and all subsequent hunks',
          action: 'accept_all',
        },
        {
          label: 'Reject this and all remaining',
          description: 'Reject this and all subsequent hunks',
          action: 'reject_all',
        },
        { label: 'Cancel review', description: 'Cancel and discard all hunks', action: 'cancel' },
      ];

      const quickPickTitle = `ForgePilot: hunk ${i + 1}/${hunks.length} - ${hunkSummary(hunk)} - ${relPath}`;
      const pick = await vscode.window.showQuickPick(items, {
        title: quickPickTitle,
        ignoreFocusOut: true,
        placeHolder: 'Select action for this hunk',
      }, cts.token);

      if (!pick || pick.action === 'cancel' || checkCancelled()) {
        return { kind: 'cancelled', reason: 'Review cancelled' };
      }

      if (pick.action === 'accept') {
        acceptedIds.push(hunk.id);
      } else if (pick.action === 'reject') {
        rejectedIds.push(hunk.id);
      } else if (pick.action === 'accept_all') {
        for (let j = i; j < hunks.length; j++) {
          acceptedIds.push(hunks[j].id);
        }
        break;
      } else if (pick.action === 'reject_all') {
        for (let j = i; j < hunks.length; j++) {
          rejectedIds.push(hunks[j].id);
        }
        break;
      }
    }

    // 5. Final confirmation
    if (acceptedIds.length === 0) {
      return { kind: 'rejected', reason: 'user rejected all hunks' };
    }

    if (checkCancelled()) {
      return { kind: 'cancelled', reason: 'Review cancelled' };
    }

    interface FinalPickItem extends vscode.QuickPickItem {
      action: 'apply' | 'discard';
    }

    const finalItems: FinalPickItem[] = [
      {
        label: `Apply ${acceptedIds.length} of ${hunks.length} hunks to ${relPath}`,
        action: 'apply',
      },
      {
        label: 'Discard all',
        action: 'discard',
      },
    ];

    const finalPick = await vscode.window.showQuickPick(finalItems, {
      title: `ForgePilot: Final confirmation for ${relPath}`,
      ignoreFocusOut: true,
    }, cts.token);

    if (!finalPick || checkCancelled()) {
      return { kind: 'cancelled', reason: 'Review cancelled' };
    }
    if (finalPick.action === 'discard') {
      return { kind: 'rejected', reason: 'User discarded changes' };
    }

    // 6. Apply ATOMICALLY with stale buffer and concurrent edit protection
    const latestDoc = await vscode.workspace.openTextDocument(fullPath);
    const latestRaw = latestDoc.getText();
    const latestNorm = latestRaw.replace(/\r\n/g, '\n');

    if (
      (typeof initialVersion === 'number' && typeof latestDoc.version === 'number' && latestDoc.version !== initialVersion) ||
      computeContentHash(latestRaw) !== baseHash ||
      latestNorm !== baseText
    ) {
      vscode.window.showWarningMessage(
        'ForgePilot: file changed since proposal was generated — skipped to protect your edits.'
      );
      return { kind: 'stale', reason: 'File changed during review' };
    }

    const newText = applySelectedHunks(baseText, hunks, acceptedIds);

    const fullRange = new vscode.Range(
      latestDoc.positionAt(0),
      latestDoc.positionAt(latestRaw.length)
    );

    const edit = new vscode.WorkspaceEdit();
    edit.replace(latestDoc.uri, fullRange, newText);

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      return { kind: 'invalid', reason: 'vscode.workspace.applyEdit returned false' };
    }

    const afterRaw = latestDoc.getText();
    const afterNorm = afterRaw.replace(/\r\n/g, '\n');
    if (afterNorm !== newText) {
      // Rollback to original text
      const rollbackRange = new vscode.Range(
        latestDoc.positionAt(0),
        latestDoc.positionAt(afterRaw.length)
      );
      const rollbackEdit = new vscode.WorkspaceEdit();
      rollbackEdit.replace(latestDoc.uri, rollbackRange, latestRaw);
      await vscode.workspace.applyEdit(rollbackEdit);
      return {
        kind: 'invalid',
        reason: 'Document text after edit did not match expected text; restored previous text',
      };
    }

    // 7. Save if not originally dirty
    let saved = false;
    if (!wasDirty) {
      saved = await latestDoc.save();
    }

    // 8. Push undo record
    pushUndoRecord({
      uri: latestDoc.uri,
      beforeText: latestRaw,
      afterText: afterRaw,
      wasSaved: saved,
      label: relPath,
    });

    return {
      kind: 'applied',
      path: fullPath,
      acceptedHunkIds: acceptedIds,
      rejectedHunkIds: rejectedIds,
      totalHunks: hunks.length,
      saved,
    };
  } finally {
    // 9. Dispose all virtual documents and close diff tabs
    for (const u of registeredUris) {
      diffContentProvider.delete(u);
    }

    try {
      const tabsToClose: vscode.Tab[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (tab.input instanceof vscode.TabInputTextDiff) {
            const origStr = tab.input.original?.toString() ?? '';
            const modStr = tab.input.modified?.toString() ?? '';
            if (origStr.includes(reviewId) || modStr.includes(reviewId)) {
              tabsToClose.push(tab);
            }
          }
        }
      }
      if (tabsToClose.length > 0) {
        await vscode.window.tabGroups.close(tabsToClose);
      }
    } catch {
      // Best effort cleanup
    }

    if (activeCancellationTokenSource === cts) {
      activeCancellationTokenSource = null;
    }
    cts.dispose();
  }
}
