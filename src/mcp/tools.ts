// src/mcp/tools.ts
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as readline from 'node:readline';
import { z } from 'zod';
import {
  validateWorkspacePath,
  isDeniedPathComponent,
  isBinaryFile,
} from './workspaceGuard.js';
import {
  MAX_RESPONSE_CHARS,
  MAX_LINE_CHARS,
  MAX_READ_LINES,
  MAX_FILE_SIZE_READ_BYTES,
  MAX_FILE_SIZE_SEARCH_BYTES,
  DEFAULT_SEARCH_RESULTS,
  MAX_SEARCH_RESULTS,
  truncateLine,
  truncateResponse,
  isIgnoredDirectory,
  isIgnoredSearchFile,
} from './limits.js';
import { take as takeDecision } from '../review/decisions.js';
import { parseProposeEditArgs, canonicalKey } from '../review/proposal.js';

export interface ToolTextContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: ToolTextContent[];
  isError?: boolean;
}

/**
 * Minimal interface representing the registerable subset of McpServer
 */
export interface McpServerLike {
  tool: (
    name: string,
    description: string,
    paramsSchema: Record<string, z.ZodTypeAny>,
    handler: (args: any) => Promise<ToolResult>
  ) => any;
}

/**
 * Matches a relative path against a simple glob pattern.
 * Supports '*' (within segment), '**' (across segments), and '?' (single char).
 */
export function matchGlob(relPath: string, globPattern?: string): boolean {
  if (!globPattern || globPattern.trim() === '' || globPattern.trim() === '*') {
    return true;
  }
  const cleanGlob = globPattern.trim().replace(/\\/g, '/');
  const cleanPath = relPath.replace(/\\/g, '/');

  let regexStr = '^';
  for (let i = 0; i < cleanGlob.length; i++) {
    const c = cleanGlob[i];
    if (c === '*' && cleanGlob[i + 1] === '*') {
      regexStr += '.*';
      i++;
      if (cleanGlob[i + 1] === '/') {
        i++;
      }
    } else if (c === '*') {
      regexStr += '[^/]*';
    } else if (c === '?') {
      regexStr += '[^/]';
    } else if (['.', '+', '^', '$', '(', ')', '[', ']', '{', '}', '|', '\\'].includes(c)) {
      regexStr += '\\' + c;
    } else {
      regexStr += c;
    }
  }
  regexStr += '$';

  try {
    const rx = new RegExp(regexStr, 'i');
    return rx.test(cleanPath) || rx.test(path.posix.basename(cleanPath));
  } catch {
    return true;
  }
}

/**
 * Reads lines from a file using a streaming reader up to maxLines,
 * ensuring files > 2 MB are never buffered fully into memory.
 */
async function streamFileLines(
  fullPath: string,
  startLine: number,
  maxLines: number
): Promise<{ lines: string[]; reachedEnd: boolean; totalScannedLines: number }> {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(fullPath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    const lines: string[] = [];
    let currentLineNum = 0;
    const targetEnd = startLine + maxLines - 1;
    let closedEarly = false;

    rl.on('line', (line) => {
      currentLineNum++;
      if (currentLineNum >= startLine && currentLineNum <= targetEnd) {
        lines.push(truncateLine(`${currentLineNum}: ${line}`, MAX_LINE_CHARS));
        if (currentLineNum === targetEnd) {
          closedEarly = true;
          rl.close();
          stream.destroy();
        }
      }
    });

    rl.on('close', () => {
      resolve({
        lines,
        reachedEnd: !closedEarly,
        totalScannedLines: currentLineNum,
      });
    });

    rl.on('error', (err) => {
      stream.destroy();
      reject(err);
    });

    stream.on('error', (err) => {
      rl.close();
      reject(err);
    });
  });
}

/**
 * Tool: read_file
 */
export async function handleReadFile(
  args: {
    path: string;
    startLine?: number;
    endLine?: number;
  },
  workspaceRoot?: string
): Promise<ToolResult> {
  try {
    if (!workspaceRoot || !workspaceRoot.trim()) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Error: No workspace folder is open.' }],
      };
    }

    if (!args || !args.path) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Error: "path" argument is required.' }],
      };
    }

    const guard = validateWorkspacePath(args.path, workspaceRoot);
    if (!guard.ok) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Error: ${guard.error}` }],
      };
    }

    let fileContent: string | null = null;
    let version = 'disk';

    // 1. Try reading from active/open VS Code TextDocuments (to see unsaved edits)
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vscode = require('vscode');
      const openDoc = vscode.workspace?.textDocuments?.find((doc: any) => {
        try {
          return path.resolve(doc.uri.fsPath) === guard.fullPath;
        } catch {
          return false;
        }
      });
      if (openDoc) {
        version = String(openDoc.version);
        fileContent = openDoc.getText();
      }
    } catch {
      // Outside VS Code host or lookup failed
    }

    const reqStart = Math.max(1, args.startLine ?? 1);
    let requestedLineCount = args.endLine ? Math.max(1, args.endLine - reqStart + 1) : MAX_READ_LINES;
    const linesToRead = Math.min(MAX_READ_LINES, requestedLineCount);

    let outputLines: string[] = [];
    let totalLinesHeader = 0;
    let totalLinesKnown = true;
    let actualEnd = reqStart;
    let isCapped = false;

    if (fileContent !== null) {
      // Document is open in editor (do not count the empty segment after the final newline as a line)
      const cleanContent = fileContent.replace(/\r?\n$/, '');
      const rawLines = cleanContent.length > 0 ? cleanContent.split(/\r?\n/) : [];
      totalLinesHeader = rawLines.length;

      if (reqStart > totalLinesHeader) {
        return {
          content: [
            {
              type: 'text',
              text: `path=${guard.relativePath} version=${version} lines=${reqStart}-${reqStart} of ${totalLinesHeader}\n[File has only ${totalLinesHeader} lines. Requested startLine is beyond end of file.]`,
            },
          ],
        };
      }

      actualEnd = Math.min(totalLinesHeader, reqStart + linesToRead - 1);
      if (actualEnd < (args.endLine ?? totalLinesHeader)) {
        isCapped = true;
      }

      for (let i = reqStart; i <= actualEnd; i++) {
        outputLines.push(truncateLine(`${i}: ${rawLines[i - 1]}`, MAX_LINE_CHARS));
      }
    } else {
      // Read from disk: stat first to enforce limits
      if (!fs.existsSync(guard.fullPath)) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: File not found: ${guard.relativePath}` }],
        };
      }

      const stat = await fs.promises.stat(guard.fullPath);
      if (stat.isDirectory()) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: Path is a directory: ${guard.relativePath}` }],
        };
      }

      if (await isBinaryFile(guard.fullPath)) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: Cannot read binary file: ${guard.relativePath}` }],
        };
      }

      // If file is larger than 2 MB, read only the requested slice via stream
      // without buffering the entire file into memory.
      const streamed = await streamFileLines(guard.fullPath, reqStart, linesToRead);
      outputLines = streamed.lines;
      actualEnd = reqStart + outputLines.length - 1;
      totalLinesKnown = streamed.reachedEnd;
      totalLinesHeader = streamed.reachedEnd ? streamed.totalScannedLines : 0;
      if (!streamed.reachedEnd || (args.endLine !== undefined && args.endLine > actualEnd)) {
        isCapped = true;
      }
    }

    const linesHeader = totalLinesKnown
      ? `lines=${reqStart}-${actualEnd} of ${totalLinesHeader}`
      : `lines=${reqStart}-${actualEnd} (file continues)`;
    const header = `path=${guard.relativePath} version=${version} ${linesHeader}`;
    let resultText = header + '\n' + outputLines.join('\n');

    if (isCapped) {
      resultText += `\n\n[Truncated: max ${MAX_READ_LINES} lines per call. Call read_file with startLine=${actualEnd + 1} to read the next range.]`;
    }

    // Enforce 16,000 character maximum response cap
    resultText = truncateResponse(
      resultText,
      `call read_file with startLine=${actualEnd + 1} to continue reading`,
      MAX_RESPONSE_CHARS
    );

    return {
      content: [{ type: 'text', text: resultText }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: `Error reading file: ${message}` }],
    };
  }
}

/**
 * Tool: search_workspace
 */
export async function handleSearchWorkspace(
  args: {
    query: string;
    glob?: string;
    maxResults?: number;
  },
  workspaceRoot?: string
): Promise<ToolResult> {
  try {
    if (!workspaceRoot || !workspaceRoot.trim()) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Error: No workspace folder is open.' }],
      };
    }

    if (!args || !args.query || typeof args.query !== 'string') {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Error: "query" argument is required.' }],
      };
    }

    const query = args.query.trim();
    if (!query) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Error: "query" cannot be empty.' }],
      };
    }

    let regex: RegExp;
    const regexMatch = query.match(/^\/(.+)\/([a-z]*)$/);
    if (regexMatch) {
      try {
        regex = new RegExp(regexMatch[1], regexMatch[2]);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Error: Invalid regular expression /${regexMatch[1]}/${regexMatch[2]}: ${message}` }],
        };
      }
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, 'i');
    }

    const limit = Math.min(MAX_SEARCH_RESULTS, Math.max(1, args.maxResults ?? DEFAULT_SEARCH_RESULTS));
    const root = path.resolve(workspaceRoot.trim());

    interface MatchLine {
      relativePath: string;
      lineNumber: number;
      text: string;
    }

    const matches: MatchLine[] = [];
    let totalMatches = 0;

    async function walk(dir: string): Promise<void> {
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(root, full).replace(/\\/g, '/');

        if (entry.isDirectory()) {
          // Skip directories matching security guard or search exclusion list
          if (isIgnoredDirectory(entry.name)) {
            continue;
          }
          const denied = isDeniedPathComponent(rel);
          if (denied.denied) {
            continue;
          }
          await walk(full);
        } else if (entry.isFile()) {
          // Skip files matching search exclusion rules (.min.js, .map, package-lock.json, etc.)
          if (isIgnoredSearchFile(rel)) {
            continue;
          }
          const denied = isDeniedPathComponent(rel);
          if (denied.denied) {
            continue;
          }
          if (!matchGlob(rel, args.glob)) {
            continue;
          }

          let stat: fs.Stats;
          try {
            stat = await fs.promises.stat(full);
          } catch {
            continue;
          }

          // Skip files larger than 1 MB
          if (stat.size > MAX_FILE_SIZE_SEARCH_BYTES) {
            continue;
          }

          if (await isBinaryFile(full)) {
            continue;
          }

          let content: string;
          try {
            content = await fs.promises.readFile(full, 'utf-8');
          } catch {
            continue;
          }

          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              totalMatches++;
              if (matches.length < limit) {
                matches.push({
                  relativePath: rel,
                  lineNumber: i + 1,
                  text: truncateLine(lines[i].trimEnd(), MAX_LINE_CHARS),
                });
              }
            }
          }
        }
      }
    }

    await walk(root);

    if (totalMatches === 0) {
      return {
        content: [{ type: 'text', text: `No matches found in workspace for query: "${query}"` }],
      };
    }

    const lines: string[] = [
      `Found ${totalMatches} total match${totalMatches === 1 ? '' : 'es'} in workspace (showing ${matches.length}):`,
    ];
    for (const m of matches) {
      lines.push(`${m.relativePath}:${m.lineNumber}: ${m.text}`);
    }

    if (totalMatches > matches.length) {
      lines.push(`\n[Result limit reached. Showing ${matches.length} of ${totalMatches} matches.]`);
    }

    let resultText = lines.join('\n');
    resultText = truncateResponse(resultText, 'refine search query or glob filter to narrow results', MAX_RESPONSE_CHARS);

    return {
      content: [{ type: 'text', text: resultText }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [{ type: 'text', text: `Error searching workspace: ${message}` }],
    };
  }
}

/**
 * Tool: propose_edit
 * Handler retrieves approved decision from the single-use decisions store.
 * NEVER writes any file directly.
 */
export async function handleProposeEdit(
  args: any,
  workspaceRoot?: string
): Promise<ToolResult> {
  if (!workspaceRoot || !workspaceRoot.trim()) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Error: No workspace folder is open.' }],
    };
  }

  const parseResult = parseProposeEditArgs(args);
  if (!parseResult.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${parseResult.error}` }],
    };
  }

  const guard = validateWorkspacePath(parseResult.args.path, workspaceRoot);
  if (!guard.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${guard.error}` }],
    };
  }

  const key = canonicalKey(parseResult.args);
  const outcome = takeDecision(key);
  if (!outcome) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: 'No approved review found for this edit; nothing was written.',
        },
      ],
    };
  }

  const acceptedStr =
    outcome.acceptedHunkIds.length > 0
      ? outcome.acceptedHunkIds.map((id) => id + 1).join(', ')
      : 'none';
  const rejectedStr =
    outcome.rejectedHunkIds.length > 0
      ? outcome.rejectedHunkIds.map((id) => id + 1).join(', ')
      : 'none';

  return {
    content: [
      {
        type: 'text',
        text: `Applied ${outcome.acceptedHunkIds.length} of ${outcome.totalHunks} hunks to ${guard.relativePath}; accepted hunks: ${acceptedStr}; rejected hunks: ${rejectedStr}; saved: ${outcome.saved ? 'yes' : 'no'}`,
      },
    ],
  };
}

/**
 * Registers editor tools onto an McpServer instance.
 * Accepts a workspaceRootProvider callback to obtain the active workspace root.
 */
export function registerEditorTools(
  server: McpServerLike,
  getWorkspaceRoot: () => string | undefined
): void {
  server.tool(
    'read_file',
    'Reads content from a file in the workspace, checking the active editor document first (to include unsaved edits) and falling back to disk. Returns line-numbered content with line/version header. Maximum 400 lines and 16,000 characters per call.',
    {
      path: z.string().describe('Relative path from workspace root, or absolute path inside the workspace.'),
      startLine: z.number().int().min(1).optional().describe('1-based line number to start reading from (inclusive). Defaults to 1.'),
      endLine: z.number().int().min(1).optional().describe('1-based line number to end reading at (inclusive). Defaults to file end.'),
    },
    async (args) => await handleReadFile(args, getWorkspaceRoot())
  );

  server.tool(
    'search_workspace',
    'Searches for text in workspace files using case-insensitive substring search or regex (when enclosed in /pattern/flags). Returns matching lines in "path:line: text" format. Ignores lockfiles, minified files, build outputs, node_modules, and git directories. Capped at 16,000 characters.',
    {
      query: z.string().describe('Search query string, or regular expression enclosed in slashes (e.g. "/function\\s+activate/i").'),
      glob: z.string().optional().describe('Optional glob pattern to filter files by path or extension (e.g. "*.ts", "src/**/*.js").'),
      maxResults: z.number().int().min(1).max(MAX_SEARCH_RESULTS).optional().describe('Maximum number of matching lines to return (default 20, max 30).'),
    },
    async (args) => await handleSearchWorkspace(args, getWorkspaceRoot())
  );

  server.tool(
    'propose_edit',
    'propose changes to ONE file; old_text must match EXACTLY ONCE, copied verbatim from read_file output WITHOUT the line-number prefixes and including enough surrounding lines to be unique; several edits for one file can go in one call; the user reviews every hunk and may reject some; the result says what was applied; there is no other way to modify files.',
    {
      path: z.string().describe('Relative path from workspace root, or absolute path inside the workspace.'),
      edits: z
        .array(
          z.object({
            old_text: z.string().describe('Exact text to replace (must match exactly once in original).'),
            new_text: z.string().describe('New replacement text.'),
          })
        )
        .describe('List of edits to apply to this file.'),
      explanation: z.string().optional().describe('Optional explanation of why these edits are being made.'),
    },
    async (args) => await handleProposeEdit(args, getWorkspaceRoot())
  );
}
