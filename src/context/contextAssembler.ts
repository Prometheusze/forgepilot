// src/context/contextAssembler.ts
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface ContextItem {
  path: string; // relative path from workspace root
  score: number;
  reasons: string[];
  chars: number;
  truncated: boolean;
  content: string;
}

export interface DeclaredSymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable';
  line: number;
}

export interface ContextAssemblyResult {
  budgetChars: number;
  usedChars: number;
  items: ContextItem[];
  omittedCount: number;
  excludedCount: number;
  report: string;
  formattedPrompt: string;
}

export interface ContextAssemblyOptions {
  workspaceRoot: string;
  prompt: string;
  activeFilePath?: string;
  activeFileContent?: string;
  budgetChars?: number;
  fileReader?: (absPath: string) => Promise<string | null>;
  dirLister?: (absDir: string) => Promise<string[]>;
  isDir?: (absPath: string) => Promise<boolean>;
}

export interface ParsedReferences {
  files: string[];
  symbols: string[];
}

const DEFAULT_BUDGET_CHARS = 24000;

const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  'out',
  'dist',
  'build',
  '.vscode',
  '.idea',
  '__pycache__',
  '.pytest_cache',
  '.venv',
  'venv',
  'env',
  'coverage',
  '.nyc_output',
  'target',
]);

const IGNORED_EXTENSIONS = new Set([
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.bin',
  '.obj',
  '.o',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.webp',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.rar',
  '.pdf',
  '.wasm',
  '.map',
  '.lock',
]);

const IGNORED_FILENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'cargo.lock',
  'gemfile.lock',
  'composer.lock',
]);

/**
 * Parses explicit @file:<path> (or @path/to/file) and @symbol:<name> references from prompt.
 */
export function parsePromptReferences(prompt: string): ParsedReferences {
  const files: string[] = [];
  const symbols: string[] = [];

  // Match @file:<path> or @file:<path>
  const fileRegex = /@file:([^\s]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = fileRegex.exec(prompt)) !== null) {
    if (match[1]) {
      files.push(match[1].trim());
    }
  }

  // Match @path/like/this.ext (e.g. @src/index.ts or @main.py)
  const pathRegex = /@((?:[a-zA-Z0-9_\-\./\\]+)\.[a-zA-Z0-9]+)/g;
  while ((match = pathRegex.exec(prompt)) !== null) {
    const candidate = match[1].trim();
    if (!candidate.startsWith('file:') && !files.includes(candidate)) {
      files.push(candidate);
    }
  }

  // Match @symbol:<name>
  const symbolRegex = /@symbol:([a-zA-Z0-9_$]+)/gi;
  while ((match = symbolRegex.exec(prompt)) !== null) {
    if (match[1]) {
      symbols.push(match[1].trim());
    }
  }

  return { files, symbols };
}

/**
 * Extracts keywords/tokens from prompt for scoring.
 */
function extractPromptTokens(prompt: string): string[] {
  // Remove @references before tokenizing
  const cleaned = prompt.replace(/@\S+/g, ' ');
  const words = cleaned.toLowerCase().match(/[a-z0-9_$]{3,}/g) || [];
  const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'this', 'that', 'which', 'file', 'code']);
  return Array.from(new Set(words.filter((w) => !stopWords.has(w))));
}

/**
 * Checks whether a relative path or filename should be excluded.
 */
export function isExcludedPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (IGNORED_DIRECTORIES.has(seg)) {
      return true;
    }
  }

  const basename = segments[segments.length - 1];
  if (IGNORED_FILENAMES.has(basename)) {
    return true;
  }

  const ext = path.posix.extname(basename).toLowerCase();
  if (IGNORED_EXTENSIONS.has(ext)) {
    return true;
  }

  return false;
}

interface CandidateFile {
  relPath: string;
  absPath: string;
  score: number;
  reasons: string[];
  content?: string;
  imports?: string[];
}

/**
 * Scans files in workspace up to maxCandidates and tracks excluded file count.
 */
async function discoverWorkspaceFiles(
  workspaceRoot: string,
  dirLister?: (absDir: string) => Promise<string[]>,
  isDirFn?: (absPath: string) => Promise<boolean>,
  maxFiles = 300
): Promise<{ files: string[]; excludedCount: number }> {
  const result: string[] = [];
  let excludedCount = 0;

  async function walk(dir: string): Promise<void> {
    if (result.length >= maxFiles) {
      return;
    }

    let entries: string[] = [];
    if (dirLister) {
      try {
        entries = await dirLister(dir);
      } catch {
        return;
      }
    } else {
      try {
        entries = await fs.promises.readdir(dir);
      } catch {
        return;
      }
    }

    for (const entry of entries) {
      if (result.length >= maxFiles) {
        break;
      }
      const fullPath = path.join(dir, entry);
      const relPath = path.relative(workspaceRoot, fullPath);

      if (isExcludedPath(relPath)) {
        excludedCount++;
        continue;
      }

      let isDirectory = false;
      if (isDirFn) {
        try {
          isDirectory = await isDirFn(fullPath);
        } catch {
          continue;
        }
      } else {
        try {
          const st = await fs.promises.stat(fullPath);
          isDirectory = st.isDirectory();
        } catch {
          continue;
        }
      }

      if (isDirectory) {
        await walk(fullPath);
      } else {
        result.push(relPath);
      }
    }
  }

  await walk(workspaceRoot);
  return { files: result, excludedCount };
}

/**
 * Lightweight, regex-based symbol extractor for Python, TypeScript, and JavaScript.
 * Returns line numbers, symbol names, and declaration kinds.
 */
export function extractDeclaredSymbols(content: string, filePath?: string): DeclaredSymbol[] {
  const symbols: DeclaredSymbol[] = [];
  const lines = content.split(/\r?\n/);
  const ext = filePath ? path.posix.extname(filePath.replace(/\\/g, '/')).toLowerCase() : '';
  const isPython = ext === '.py' || (!ext && (content.includes('def ') || content.includes('import os')));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (isPython) {
      // Python: def foo / async def foo
      const defMatch = /(?:^|\s+)(?:async\s+)?def\s+([a-zA-Z_][a-zA-Z0-9_]*)/.exec(line);
      if (defMatch) {
        symbols.push({ name: defMatch[1], kind: 'function', line: lineNum });
        continue;
      }
      // Python: class Foo
      const classMatch = /(?:^|\s+)class\s+([a-zA-Z_][a-zA-Z0-9_]*)/.exec(line);
      if (classMatch) {
        symbols.push({ name: classMatch[1], kind: 'class', line: lineNum });
        continue;
      }
    } else {
      // TypeScript / JavaScript
      // function foo / export function foo / export async function foo
      const fnMatch = /(?:^|\s+)(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/.exec(line);
      if (fnMatch) {
        symbols.push({ name: fnMatch[1], kind: 'function', line: lineNum });
        continue;
      }
      // class Foo / export class Foo
      const classMatch = /(?:^|\s+)(?:export\s+)?(?:abstract\s+)?class\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/.exec(line);
      if (classMatch) {
        symbols.push({ name: classMatch[1], kind: 'class', line: lineNum });
        continue;
      }
      // interface Foo / export interface Foo
      const ifaceMatch = /(?:^|\s+)(?:export\s+)?interface\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/.exec(line);
      if (ifaceMatch) {
        symbols.push({ name: ifaceMatch[1], kind: 'interface', line: lineNum });
        continue;
      }
      // type Foo = / export type Foo =
      const typeMatch = /(?:^|\s+)(?:export\s+)?type\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/.exec(line);
      if (typeMatch) {
        symbols.push({ name: typeMatch[1], kind: 'type', line: lineNum });
        continue;
      }
      // export const foo = / export let foo =
      const constMatch = /(?:^|\s+)export\s+(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[:=]/.exec(line);
      if (constMatch) {
        symbols.push({ name: constMatch[1], kind: 'variable', line: lineNum });
        continue;
      }
    }
  }

  return symbols;
}

/**
 * Extracts local import targets from Python and TypeScript/JavaScript files.
 */
export function extractLocalImports(content: string, fileRelPath: string): string[] {
  const imports: string[] = [];
  const normPath = fileRelPath.replace(/\\/g, '/');
  const fileDir = path.posix.dirname(normPath);
  const ext = path.posix.extname(normPath).toLowerCase();
  const isPython = ext === '.py';

  if (isPython) {
    // 1. from .foo import bar / from ..foo import bar / from . import foo
    const relImportRegex = /(?:^|\n)\s*from\s+(\.+[a-zA-Z0-9_.]*)\s+import/g;
    let m: RegExpExecArray | null;
    while ((m = relImportRegex.exec(content)) !== null) {
      const rawTarget = m[1];
      const dots = rawTarget.match(/^\.+/)?.[0] || '.';
      const rest = rawTarget.slice(dots.length).replace(/\./g, '/');
      let baseDir = fileDir;
      for (let i = 1; i < dots.length; i++) {
        baseDir = path.posix.dirname(baseDir);
      }
      const resolved = rest ? path.posix.normalize(path.posix.join(baseDir, rest)) : baseDir;
      imports.push(resolved);
    }

    // 2. from flask.helpers import get_debug_flag / import flask.cli
    const absImportRegex = /(?:^|\n)\s*(?:from|import)\s+([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)/g;
    while ((m = absImportRegex.exec(content)) !== null) {
      const modPath = m[1].replace(/\./g, '/');
      imports.push(modPath);
    }
  } else {
    // TS / JS: import ... from './foo' / require('./foo')
    const importRegex = /(?:import|export)\s+(?:.*?from\s+)?['"](\.[^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = importRegex.exec(content)) !== null) {
      const rawTarget = m[1];
      const resolved = path.posix.normalize(path.posix.join(fileDir, rawTarget));
      imports.push(resolved);
    }
    const requireRegex = /require\(['"](\.[^'"]+)['"]\)/g;
    while ((m = requireRegex.exec(content)) !== null) {
      const rawTarget = m[1];
      const resolved = path.posix.normalize(path.posix.join(fileDir, rawTarget));
      imports.push(resolved);
    }
  }

  return Array.from(new Set(imports));
}

/**
 * Pure Node Context Assembler
 */
export async function assembleContext(options: ContextAssemblyOptions): Promise<ContextAssemblyResult> {
  const budgetChars = options.budgetChars && options.budgetChars > 0 ? options.budgetChars : DEFAULT_BUDGET_CHARS;
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const promptTokens = extractPromptTokens(options.prompt);
  const { files: explicitFiles, symbols: explicitSymbols } = parsePromptReferences(options.prompt);

  const fileReader =
    options.fileReader ||
    (async (abs: string) => {
      try {
        return await fs.promises.readFile(abs, 'utf-8');
      } catch {
        return null;
      }
    });

  // 1. Discover files in workspace
  const discovered = await discoverWorkspaceFiles(workspaceRoot, options.dirLister, options.isDir);
  const allRelPathsSet = new Set<string>(discovered.files);

  // Add explicit files if not already discovered
  for (const ef of explicitFiles) {
    const normalized = ef.replace(/\\/g, '/');
    allRelPathsSet.add(normalized);
  }

  // Add active file if provided
  let activeRelPath: string | undefined = undefined;
  if (options.activeFilePath) {
    activeRelPath = path.relative(workspaceRoot, path.resolve(options.activeFilePath)).replace(/\\/g, '/');
    allRelPathsSet.add(activeRelPath);
  }

  // 2. Score candidate files
  const candidates: CandidateFile[] = [];

  for (const relPath of allRelPathsSet) {
    if (isExcludedPath(relPath)) {
      continue;
    }

    const normRelPath = relPath.replace(/\\/g, '/');
    const absPath = path.resolve(workspaceRoot, relPath);
    let score = 0;
    const reasons: string[] = [];

    // (a) Explicit file match
    const isExplicitFile = explicitFiles.some((ef) => {
      const normEf = ef.replace(/\\/g, '/');
      return normRelPath === normEf || normRelPath.endsWith('/' + normEf) || path.posix.basename(normRelPath) === normEf;
    });

    if (isExplicitFile) {
      score += 1000;
      reasons.push('explicit @file match');
    }

    // (b) Active editor file
    if (activeRelPath && normRelPath === activeRelPath) {
      score += 500;
      reasons.push('active editor file');
    }

    // (c) Filename / path token overlap
    const pathTokens = normRelPath.toLowerCase().split(/[/_.-]/).filter((t) => t.length >= 3);
    const matchedPathTokens = promptTokens.filter((pt) => pathTokens.includes(pt));
    if (matchedPathTokens.length > 0) {
      const pathScore = matchedPathTokens.length * 100;
      score += pathScore;
      reasons.push(`matched path token: ${matchedPathTokens.join(', ')}`);
    }

    // Read content to check symbol definitions and content keywords
    let content: string | null = null;
    if (activeRelPath && normRelPath === activeRelPath && typeof options.activeFileContent === 'string') {
      content = options.activeFileContent;
    } else {
      content = await fileReader(absPath);
    }

    let localImports: string[] = [];
    if (content) {
      const declaredSymbols = extractDeclaredSymbols(content, normRelPath);
      const declaredMap = new Map<string, DeclaredSymbol>();
      for (const s of declaredSymbols) {
        declaredMap.set(s.name.toLowerCase(), s);
      }

      // Check explicit @symbol:<name>
      for (const sym of explicitSymbols) {
        const lowerSym = sym.toLowerCase();
        if (declaredMap.has(lowerSym)) {
          const matched = declaredMap.get(lowerSym)!;
          score += 800;
          reasons.push(`defines symbol '${matched.name}'`);
        } else if (content.includes(sym)) {
          score += 400;
          reasons.push(`contains symbol reference '${sym}'`);
        }
      }

      // Check prompt tokens matching declared symbol definitions
      for (const tok of promptTokens) {
        const lowerTok = tok.toLowerCase();
        if (declaredMap.has(lowerTok) && !explicitSymbols.some((s) => s.toLowerCase() === lowerTok)) {
          const matched = declaredMap.get(lowerTok)!;
          score += 300;
          reasons.push(`defines symbol '${matched.name}'`);
        }
      }

      // Check content keywords
      const matchedContentWords: string[] = [];
      let contentKeywordScore = 0;
      for (const tok of promptTokens) {
        if (content.toLowerCase().includes(tok) && !declaredMap.has(tok.toLowerCase())) {
          matchedContentWords.push(tok);
          contentKeywordScore += 20;
          if (contentKeywordScore >= 100) {
            break;
          }
        }
      }
      if (matchedContentWords.length > 0) {
        score += contentKeywordScore;
        reasons.push(`contains prompt keyword: ${matchedContentWords.slice(0, 3).join(', ')}`);
      }

      localImports = extractLocalImports(content, normRelPath);
    }

    // Always push candidates so 1-hop import boosting can discover dependent files
    candidates.push({
      relPath: normRelPath,
      absPath,
      score,
      reasons,
      content: content || '',
      imports: localImports,
    });
  }

  // (e) 1-hop local import/dependency graph expansion
  // Candidates with initial score >= 300 are treated as priority sources
  const prioritySources = candidates.filter((c) => c.score >= 300);
  for (const source of prioritySources) {
    for (const imp of source.imports || []) {
      const normImp = imp.replace(/\\/g, '/');
      for (const target of candidates) {
        if (target.relPath === source.relPath) {
          continue;
        }
        const tPath = target.relPath;
        const matchesImport =
          tPath === normImp ||
          tPath === `${normImp}.py` ||
          tPath === `${normImp}.ts` ||
          tPath === `${normImp}.js` ||
          tPath === `${normImp}/__init__.py` ||
          tPath === `${normImp}/index.ts` ||
          tPath === `${normImp}/index.js` ||
          tPath.endsWith(`/${normImp}.py`) ||
          tPath.endsWith(`/${normImp}.ts`) ||
          tPath.replace(/\.[a-zA-Z0-9]+$/, '') === normImp;

        if (matchesImport) {
          const reasonText = `imported by ${source.relPath}`;
          if (!target.reasons.includes(reasonText)) {
            target.score += 250;
            target.reasons.push(reasonText);
          }
        }
      }
    }
  }

  // Keep only candidates with score > 0 after 1-hop graph expansion
  const scoredCandidates = candidates.filter((c) => c.score > 0);

  // Sort candidates by score descending, then by path alphabetically
  scoredCandidates.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.relPath.localeCompare(b.relPath);
  });

  // 3. Pack items into budget
  const items: ContextItem[] = [];
  let usedChars = 0;
  let omittedCount = 0;

  for (const c of scoredCandidates) {
    const rawContent = c.content || '';
    const fileHeader = `--- File: ${c.relPath} ---\n`;
    const fileFooter = '\n\n';
    const overhead = fileHeader.length + fileFooter.length;

    const remainingBudget = budgetChars - usedChars;
    if (remainingBudget <= overhead + 100) {
      omittedCount++;
      continue;
    }

    const availableForContent = remainingBudget - overhead;
    let itemContent: string;
    let truncated = false;

    if (rawContent.length <= availableForContent) {
      itemContent = rawContent;
    } else {
      const truncationMarker = '\n[... truncated due to context budget]';
      const maxSlice = Math.max(0, availableForContent - truncationMarker.length);
      itemContent = rawContent.slice(0, maxSlice) + truncationMarker;
      truncated = true;
    }

    const itemChars = overhead + itemContent.length;
    usedChars += itemChars;

    items.push({
      path: c.relPath,
      score: c.score,
      reasons: c.reasons,
      chars: itemChars,
      truncated,
      content: itemContent,
    });
  }

  // 4. Format Context Assembly Report
  const percentUsed = budgetChars > 0 ? Math.round((usedChars / budgetChars) * 100) : 0;
  const reportLines: string[] = [
    '--- Context Assembly Report ---',
    `Budget: ${budgetChars.toLocaleString()} chars | Used: ${usedChars.toLocaleString()} chars (${percentUsed}%) | Omitted files: ${omittedCount} | Excluded files: ${discovered.excludedCount}`,
  ];

  if (items.length === 0) {
    reportLines.push('No relevant workspace context files identified.');
  } else {
    for (const it of items) {
      const truncLabel = it.truncated ? ', truncated' : '';
      reportLines.push(
        `- ${it.path} (score: ${it.score}, ${it.chars.toLocaleString()} chars${truncLabel}) [${it.reasons.join(', ')}]`
      );
    }
  }
  reportLines.push('-------------------------------');
  const report = reportLines.join('\n');

  // 5. Build formatted prompt with context envelope
  let formattedPrompt = options.prompt;
  if (items.length > 0) {
    const contextSections: string[] = [];
    for (const it of items) {
      contextSections.push(`--- File: ${it.path}${it.truncated ? ' (truncated)' : ''} ---\n${it.content}`);
    }
    formattedPrompt = `${options.prompt}\n\n<workspace_context>\n${contextSections.join('\n\n')}\n</workspace_context>`;
  }

  return {
    budgetChars,
    usedChars,
    items,
    omittedCount,
    excludedCount: discovered.excludedCount,
    report,
    formattedPrompt,
  };
}
