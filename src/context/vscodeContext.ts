// src/context/vscodeContext.ts
import * as vscode from 'vscode';
import { assembleContext, ContextAssemblyResult } from './contextAssembler.js';

/**
 * VS Code wrapper around the pure assembleContext engine.
 * Reads the active workspace root, active editor document, and user configuration.
 */
export async function assembleWorkspaceContext(
  prompt: string,
  activeEditor?: vscode.TextEditor,
  customBudgetChars?: number
): Promise<ContextAssemblyResult | null> {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    return null;
  }

  const config = vscode.workspace.getConfiguration('forgepilot');
  const configuredBudget = config.get<number>('contextBudgetChars', 24000);
  const budgetChars = customBudgetChars && customBudgetChars > 0 ? customBudgetChars : configuredBudget;

  let activeFilePath: string | undefined = undefined;
  let activeFileContent: string | undefined = undefined;

  const editor = activeEditor || vscode.window.activeTextEditor;
  if (editor && !editor.document.isUntitled) {
    activeFilePath = editor.document.uri.fsPath;
    activeFileContent = editor.document.getText();
  }

  return await assembleContext({
    workspaceRoot,
    prompt,
    activeFilePath,
    activeFileContent,
    budgetChars,
  });
}
