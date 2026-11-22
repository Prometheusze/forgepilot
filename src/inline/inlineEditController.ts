// src/inline/inlineEditController.ts
import * as vscode from 'vscode';
import * as path from 'node:path';
import { assembleWorkspaceContext } from '../context/vscodeContext.js';
import { executeAgentTurnWithFallback } from '../agent/runAgent.js';
import { uiEventBus } from '../ui/eventBus.js';

/**
 * Controller for the "ForgePilot: Inline Edit" command (Ctrl+Alt+K / Cmd+Alt+K).
 * 1. Reads the active file and editor selection (or surrounding lines if cursor selection is empty).
 * 2. Accepts promptOverride from sidebar or prompts user via inputBox.
 * 3. Assembles explainable workspace context, logging to OutputChannel and notifying eventBus.
 * 4. Dispatches the focused inline edit prompt through TrueForge with automatic model fallback.
 * 5. Changes must route exclusively through propose_edit -> approval pause -> diff review.
 */
export async function runInlineEdit(
  channel: vscode.OutputChannel,
  runGeneration: number,
  isCurrentGen: () => boolean,
  setActiveSessionId: (id: string | null) => void,
  promptOverride?: string
): Promise<void> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage('ForgePilot: Open a folder first.');
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.isUntitled) {
    vscode.window.showErrorMessage('ForgePilot: No active saved file in editor.');
    return;
  }

  const document = editor.document;
  const filePath = document.uri.fsPath;
  const relPath = path.relative(workspaceRoot, filePath).replace(/\\/g, '/');

  // Extract selected text or surrounding region
  const selection = editor.selection;
  let targetRegionText: string;
  let startLine: number;
  let endLine: number;

  if (!selection.isEmpty) {
    startLine = selection.start.line + 1;
    endLine = selection.end.line + 1;
    targetRegionText = document.getText(selection);
  } else {
    const cursorLine = selection.active.line;
    const totalLines = document.lineCount;
    const windowStart = Math.max(0, cursorLine - 5);
    const windowEnd = Math.min(totalLines - 1, cursorLine + 5);
    startLine = windowStart + 1;
    endLine = windowEnd + 1;

    const startPos = new vscode.Position(windowStart, 0);
    const endPos = new vscode.Position(windowEnd, document.lineAt(windowEnd).text.length);
    targetRegionText = document.getText(new vscode.Range(startPos, endPos));
  }

  let instruction = promptOverride && promptOverride.trim().length > 0 ? promptOverride.trim() : undefined;
  if (!instruction) {
    instruction = await vscode.window.showInputBox({
      title: `ForgePilot Inline Edit: ${path.basename(relPath)} (lines ${startLine}-${endLine})`,
      prompt: 'Enter instructions for the edit (supports @file and @symbol)',
      placeHolder: 'e.g. Add validation to parameters or refactor this method',
      ignoreFocusOut: true,
    });
  }

  if (!instruction || !instruction.trim()) {
    return;
  }

  if (!isCurrentGen()) {
    return;
  }

  channel.show(true);
  channel.appendLine(`\n>>> ForgePilot: Inline Edit (Run #${runGeneration})`);
  channel.appendLine(`Target file: ${relPath} (lines ${startLine}-${endLine})`);
  channel.appendLine(`Instruction: ${instruction}\n`);

  // Run Context Assembly
  channel.appendLine('[Context Assembly] Assembling context across workspace...');
  const contextResult = await assembleWorkspaceContext(instruction, editor);
  if (contextResult) {
    channel.appendLine(contextResult.report);
    uiEventBus.emit({
      type: 'contextAssembled',
      generation: runGeneration,
      report: {
        budgetChars: contextResult.budgetChars,
        usedChars: contextResult.usedChars,
        omittedCount: contextResult.omittedCount,
        items: contextResult.items.map((it) => ({
          path: it.path,
          score: it.score,
          chars: it.chars,
          truncated: it.truncated,
          reasons: it.reasons,
        })),
      },
    });
  }

  // Construct focused prompt
  const promptLines: string[] = [
    `You are performing an INLINE EDIT on file: "${relPath}".`,
    `User instruction: ${instruction}`,
    '',
    `Target region lines ${startLine}-${endLine}:`,
    '```',
    targetRegionText,
    '```',
    '',
    'Rules:',
    `1. Call propose_edit for "${relPath}".`,
    '2. old_text must match the original text verbatim (without line-number prefixes).',
    '3. Do not modify files directly; only propose_edit is permitted.',
    '4. Verify the exact content by calling read_file if needed before proposing edits.',
  ];

  if (contextResult && contextResult.items.length > 0) {
    promptLines.push('', '<workspace_context>');
    for (const item of contextResult.items) {
      promptLines.push(`--- File: ${item.path}${item.truncated ? ' (truncated)' : ''} ---\n${item.content}`);
    }
    promptLines.push('</workspace_context>');
  }

  const focusedPrompt = promptLines.join('\n');

  await executeAgentTurnWithFallback({
    channel,
    prompt: focusedPrompt,
    workspaceRoot,
    runTitle: `ForgePilot: Inline Edit (${path.basename(relPath)})`,
    runMode: 'inline',
    customInstructions:
      'You are ForgePilot performing an inline code edit. Modify code exclusively by calling propose_edit. Verify target lines first with read_file if uncertain. Keep edits targeted and exact.',
    runGeneration,
    isCurrentGen,
    setActiveSessionId,
  });
}
