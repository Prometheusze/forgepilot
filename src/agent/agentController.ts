// src/agent/agentController.ts
import * as vscode from 'vscode';
import { assembleWorkspaceContext } from '../context/vscodeContext.js';
import { executeAgentTurnWithFallback } from './runAgent.js';
import { uiEventBus } from '../ui/eventBus.js';

/**
 * Controller for "ForgePilot: Agent Mode" (autonomous multi-file agent).
 * 1. Accepts promptOverride from sidebar or prompts user via inputBox.
 * 2. Automatically assembles explainable workspace context and notifies eventBus.
 * 3. Dispatches the multi-file task to TrueForge with automatic model fallback.
 * 4. Agent discovers files via search_workspace/read_file, proposes changes via propose_edit,
 *    and verifies changes or tests via guarded run_terminal_command.
 */
export async function runAgentMode(
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

  let taskPrompt = promptOverride && promptOverride.trim().length > 0 ? promptOverride.trim() : undefined;
  if (!taskPrompt) {
    taskPrompt = await vscode.window.showInputBox({
      title: 'ForgePilot: Agent Mode',
      prompt: 'Describe the task to execute (supports @file and @symbol)',
      placeHolder: 'e.g. Implement input validation, add unit tests, and verify tests pass',
      ignoreFocusOut: true,
    });
  }

  if (!taskPrompt || !taskPrompt.trim()) {
    return;
  }

  if (!isCurrentGen()) {
    return;
  }

  channel.show(true);
  channel.appendLine(`\n>>> ForgePilot: Agent Mode (Run #${runGeneration})`);
  channel.appendLine(`Task: ${taskPrompt}\n`);

  // Run Context Assembly across workspace
  channel.appendLine('[Context Assembly] Assembling workspace context...');
  const contextResult = await assembleWorkspaceContext(taskPrompt);
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

  // Format prompt with context envelope
  let fullPrompt = taskPrompt;
  if (contextResult && contextResult.items.length > 0) {
    fullPrompt = `${taskPrompt}\n\n<workspace_context>\n${contextResult.items
      .map((it) => `--- File: ${it.path}${it.truncated ? ' (truncated)' : ''} ---\n${it.content}`)
      .join('\n\n')}\n</workspace_context>`;
  }

  const agentInstructions =
    'You are ForgePilot Agent Mode, an autonomous coding agent operating inside VS Code. ' +
    'Explore the workspace using search_workspace, read_file, and get_symbols. ' +
    'ALL file changes (implementation code, tests, and documentation) MUST go through propose_edit. NEVER use run_terminal_command to write, overwrite, or delete files (shell file writes are blocked). ' +
    'Make minimal, surgical additions via propose_edit and NEVER delete existing tests or unrelated code. ' +
    'For multi-part tasks (such as feature + tests + documentation), locate and update EVERY requested area (source, test suite, and docs) via propose_edit before finishing. ' +
    'Use run_terminal_command only for running tests or verification commands (use cross-platform commands like python -m ... rather than Unix-only export syntax), and confirm all existing and new tests pass before concluding.';

  await executeAgentTurnWithFallback({
    channel,
    prompt: fullPrompt,
    workspaceRoot,
    runTitle: 'ForgePilot: Agent Mode',
    runMode: 'agent',
    customInstructions: agentInstructions,
    runGeneration,
    isCurrentGen,
    setActiveSessionId,
  });
}
