// src/mcp/tools.ts
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as child_process from 'node:child_process';
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
import { extractDeclaredSymbols } from '../context/contextAssembler.js';

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
 * Helper to check whether child path is inside parent directory.
 * On Windows, comparison is case-insensitive so C:\ and c:\ match correctly.
 */
export function isWorkspaceSubdirectory(parent: string, child: string): boolean {
  const normParent = path.resolve(parent);
  const normChild = path.resolve(child);
  const p = process.platform === 'win32' ? normParent.toLowerCase() : normParent;
  const c = process.platform === 'win32' ? normChild.toLowerCase() : normChild;
  const rel = path.relative(p, c);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Tool: run_terminal_command
 * Runs a terminal command inside the workspace after approval.
 * Normalizes paths and checks containment case-insensitively on Windows.
 * Caps timeout at 30,000 ms and truncates combined stdout/stderr to MAX_RESPONSE_CHARS.
 */
/**
 * Deterministic diff-safety guard: blocks shell commands that attempt to
 * create, overwrite, edit, or delete workspace files outside propose_edit.
 */
export function detectShellFileWriteBypass(command: string): string | null {
  const cmd = command.trim();
  if (!cmd) return null;

  // Allow harmless redirection to /dev/null or NUL, block other output redirections
  const strippedNullRedir = cmd.replace(/(?:[12&]?)>>?\s*(?:\/dev\/null|NUL\b)/gi, '');
  if (/(?:^|[^<=>])(?:[12]?>>?)(?!&\d)/.test(strippedNullRedir)) {
    return 'shell output redirection (>, >>)';
  }
  if (/\b(?:Set-Content|Out-File|Add-Content|New-Item)\b/i.test(cmd)) {
    return 'PowerShell file-write cmdlet';
  }
  if (/\b(?:sed|perl)\s+[^\n]*-i\b/i.test(cmd) || /(?:^|[|;&\s])tee\s+/i.test(cmd)) {
    return 'in-place stream/file writer (sed -i / perl -i / tee)';
  }
  if (
    /\b(?:python3?|py|node)\b[^\n]*(?:-c|-e|--eval)\b/i.test(cmd) &&
    /(?:open\s*\([^)]*['"][wa+]|\.write_text\s*\(|\.write_bytes\s*\(|writeFileSync\s*\(|writeFile\s*\(|unlinkSync\s*\()/i.test(cmd)
  ) {
    return 'inline script file write';
  }
  if (/(?:^|[;&|]\s*)(?:rm|del|erase|rmdir|mv|Remove-Item|Move-Item)\s+/i.test(cmd)) {
    return 'destructive file delete/move command';
  }
  return null;
}

export async function handleRunTerminalCommand(
  args: {
    command: string;
    cwd?: string;
    timeoutMs?: number;
  },
  workspaceRoot?: string
): Promise<ToolResult> {
  if (!workspaceRoot || !workspaceRoot.trim()) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Error: No workspace folder is open.' }],
    };
  }

  if (!args || typeof args.command !== 'string' || !args.command.trim()) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Error: command parameter is required and cannot be empty.' }],
    };
  }

  const bypassReason = detectShellFileWriteBypass(args.command);
  if (bypassReason) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Direct file modification via run_terminal_command is blocked to protect diff review safety (reason: ${bypassReason}). You MUST use propose_edit for all code, test, and documentation changes.`,
        },
      ],
    };
  }

  const rootResolved = path.resolve(workspaceRoot);
  const targetCwd = args.cwd ? path.resolve(rootResolved, args.cwd) : rootResolved;

  if (!isWorkspaceSubdirectory(rootResolved, targetCwd)) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Error: Working directory "${args.cwd}" is outside the workspace root.`,
        },
      ],
    };
  }

  const timeout = Math.min(Math.max(1000, Number(args.timeoutMs) || 15000), 30000);

  // If workspace has a local .venv, ensure its Scripts/bin is on PATH so tools like pytest/flask resolve
  const venvBin = path.join(rootResolved, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
  const envPath = fs.existsSync(venvBin)
    ? `${venvBin}${path.delimiter}${process.env.PATH || ''}`
    : process.env.PATH;

  return new Promise<ToolResult>((resolve) => {
    child_process.exec(
      args.command,
      {
        cwd: targetCwd,
        timeout,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, PATH: envPath },
      },
      (err, stdout, stderr) => {
        const exitCode = typeof err?.code === 'number' ? err.code : (err ? 1 : 0);
        const timedOut = Boolean(err && (err.killed || err.signal === 'SIGTERM' || err.message?.includes('timed out')));

        const outputParts: string[] = [];
        if (timedOut) {
          outputParts.push(`[Command timed out after ${timeout}ms]`);
        }
        outputParts.push(`Exit code: ${exitCode}`);

        if (stdout && stdout.trim().length > 0) {
          outputParts.push(`--- stdout ---\n${stdout.trimEnd()}`);
        }
        if (stderr && stderr.trim().length > 0) {
          outputParts.push(`--- stderr ---\n${stderr.trimEnd()}`);
        }

        if (outputParts.length === 1 && !timedOut) {
          outputParts.push('[Command produced no output]');
        }

        let fullOutput = outputParts.join('\n\n');
        fullOutput = truncateResponse(
          fullOutput,
          'command output was truncated',
          MAX_RESPONSE_CHARS
        );

        resolve({
          isError: exitCode !== 0,
          content: [{ type: 'text', text: fullOutput }],
        });
      }
    );
  });
}

/**
 * Handles the get_symbols tool.
 * Extracts declared symbols from a source file in the workspace with line numbers.
 */
export async function handleGetSymbols(
  args: any,
  workspaceRoot?: string
): Promise<ToolResult> {
  if (!workspaceRoot || !workspaceRoot.trim()) {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Error: No workspace folder is open.' }],
    };
  }

  const rawPath = args?.path;
  if (!rawPath || typeof rawPath !== 'string') {
    return {
      isError: true,
      content: [{ type: 'text', text: 'Parameter "path" must be a non-empty string.' }],
    };
  }

  const guard = validateWorkspacePath(rawPath, workspaceRoot);
  if (!guard.ok) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Path validation failed: ${guard.error}` }],
    };
  }

  const absPath = guard.fullPath;
  const relPath = guard.relativePath;

  const denied = isDeniedPathComponent(relPath);
  if (denied.denied) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Access denied to path component: ${relPath}` }],
    };
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(absPath);
  } catch {
    return {
      isError: true,
      content: [{ type: 'text', text: `File not found: ${relPath}` }],
    };
  }

  if (stat.isDirectory()) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Path is a directory, not a file: ${relPath}` }],
    };
  }

  if (stat.size > MAX_FILE_SIZE_READ_BYTES) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `File size (${stat.size} bytes) exceeds maximum limit (${MAX_FILE_SIZE_READ_BYTES} bytes): ${relPath}`,
        },
      ],
    };
  }

  if (await isBinaryFile(absPath)) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Cannot inspect symbols in binary file: ${relPath}` }],
    };
  }

  let content: string;
  try {
    content = await fs.promises.readFile(absPath, 'utf-8');
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Failed to read file: ${err.message}` }],
    };
  }

  const symbols = extractDeclaredSymbols(content, relPath);
  if (symbols.length === 0) {
    return {
      content: [{ type: 'text', text: `No declared symbols found in ${relPath}` }],
    };
  }

  const lines = [
    `Symbols in ${relPath} (${symbols.length} declared):`,
    ...symbols.map((s) => `L${s.line}: ${s.kind} ${s.name}`),
  ];

  let output = lines.join('\n');
  output = truncateResponse(output, 'symbols output truncated', MAX_RESPONSE_CHARS);

  return {
    content: [{ type: 'text', text: output }],
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

  server.tool(
    'run_terminal_command',
    'Runs a read-only or test/verification shell command inside the workspace directory. Requires user approval. Direct file writes, redirections, and deletes are blocked (use propose_edit for all file modifications). Output is capped at 16,000 characters and execution times out after 30 seconds max.',
    {
      command: z.string().describe('The shell command line to execute.'),
      cwd: z.string().optional().describe('Relative path to directory to execute command in (defaults to workspace root).'),
      timeoutMs: z.number().int().min(1000).max(30000).optional().describe('Timeout in milliseconds (default 15000, max 30000).'),
    },
    async (args) => await handleRunTerminalCommand(args, getWorkspaceRoot())
  );

  server.tool(
    'get_symbols',
    'Extracts declared symbols (functions, classes, interfaces, types, methods) from a source file with line numbers.',
    {
      path: z.string().describe('Relative path from workspace root, or absolute path inside the workspace to inspect symbols for.'),
    },
    async (args) => await handleGetSymbols(args, getWorkspaceRoot())
  );
}
