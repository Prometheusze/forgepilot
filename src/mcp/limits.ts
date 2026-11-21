// src/mcp/limits.ts
import * as path from 'node:path';

export const MAX_RESPONSE_CHARS = 16000;
export const MAX_LINE_CHARS = 300;
export const MAX_READ_LINES = 400;
export const MAX_FILE_SIZE_READ_BYTES = 2 * 1024 * 1024; // 2 MB
export const MAX_FILE_SIZE_SEARCH_BYTES = 1 * 1024 * 1024; // 1 MB
export const DEFAULT_SEARCH_RESULTS = 20;
export const MAX_SEARCH_RESULTS = 30;

export const DENIED_SEARCH_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'out',
  'dist',
  'build',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  'coverage',
  '.vscode-test',
]);

export const DENIED_SEARCH_FILE_NAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
]);

const DENIED_SEARCH_EXTENSIONS = ['.min.js', '.map', '.asar'];

/**
 * Truncates a single line to maxLen characters, appending a marker if truncated.
 */
export function truncateLine(line: string, maxLen = MAX_LINE_CHARS): string {
  if (line.length <= maxLen) {
    return line;
  }
  return line.slice(0, maxLen) + '…[line truncated]';
}

/**
 * Ensures that the full formatted response does not exceed maxChars (16,000 by default).
 * If truncated, appends continuation instructions so the agent knows how to proceed.
 */
export function truncateResponse(
  text: string,
  continuationHint = 'call read_file with startLine to continue or refine search query',
  maxChars = MAX_RESPONSE_CHARS
): string {
  if (text.length <= maxChars) {
    return text;
  }

  const notice = `\n\n[Response truncated to ${maxChars} characters; ${continuationHint}]`;
  const availableLength = maxChars - notice.length;

  if (availableLength <= 0) {
    return text.slice(0, maxChars);
  }

  return text.slice(0, availableLength) + notice;
}

/**
 * Checks whether a directory should be skipped during workspace search.
 */
export function isIgnoredDirectory(dirName: string): boolean {
  return DENIED_SEARCH_DIRECTORIES.has(dirName);
}

/**
 * Checks whether a file should be skipped during workspace search based on name, extension, or size.
 */
export function isIgnoredSearchFile(relPath: string, size?: number): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  const basename = path.posix.basename(normalized);

  if (DENIED_SEARCH_FILE_NAMES.has(basename)) {
    return true;
  }

  const lowerBase = basename.toLowerCase();
  for (const ext of DENIED_SEARCH_EXTENSIONS) {
    if (lowerBase.endsWith(ext)) {
      return true;
    }
  }

  if (typeof size === 'number' && size > MAX_FILE_SIZE_SEARCH_BYTES) {
    return true;
  }

  return false;
}
