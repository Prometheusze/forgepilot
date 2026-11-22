// src/context/contextChecks.ts
import * as assert from 'node:assert';
import {
  parsePromptReferences,
  isExcludedPath,
  assembleContext,
  extractDeclaredSymbols,
  extractLocalImports,
} from './contextAssembler.js';

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS [${name}]`);
    passed++;
  } catch (err) {
    console.error(`FAIL [${name}]:`, err);
    failed++;
  }
}

async function main(): Promise<void> {
  console.log('=== Running Context Assembly Checks ===\n');

  // 1. Reference Parsing
  await runTest('parsePromptReferences: extracts @file, @path, and @symbol', () => {
    const prompt = 'Please refactor @file:src/auth.ts and check @utils/helpers.js for @symbol:validateToken';
    const refs = parsePromptReferences(prompt);
    assert.deepStrictEqual(refs.files, ['src/auth.ts', 'utils/helpers.js']);
    assert.deepStrictEqual(refs.symbols, ['validateToken']);
  });

  await runTest('parsePromptReferences: handles empty or non-referencing prompt', () => {
    const refs = parsePromptReferences('Fix the bug in the login form');
    assert.strictEqual(refs.files.length, 0);
    assert.strictEqual(refs.symbols.length, 0);
  });

  // 2. Directory and File Exclusions
  await runTest('isExcludedPath: excludes node_modules, .git, out, dist, and build', () => {
    assert.strictEqual(isExcludedPath('node_modules/pkg/index.js'), true);
    assert.strictEqual(isExcludedPath('.git/HEAD'), true);
    assert.strictEqual(isExcludedPath('out/extension.js'), true);
    assert.strictEqual(isExcludedPath('dist/bundle.js'), true);
    assert.strictEqual(isExcludedPath('build/output.js'), true);
    assert.strictEqual(isExcludedPath('__pycache__/mod.pyc'), true);
    assert.strictEqual(isExcludedPath('.venv/bin/python'), true);
  });

  await runTest('isExcludedPath: excludes lockfiles and binary extensions', () => {
    assert.strictEqual(isExcludedPath('package-lock.json'), true);
    assert.strictEqual(isExcludedPath('yarn.lock'), true);
    assert.strictEqual(isExcludedPath('pnpm-lock.yaml'), true);
    assert.strictEqual(isExcludedPath('assets/image.png'), true);
    assert.strictEqual(isExcludedPath('bin/tool.exe'), true);
    assert.strictEqual(isExcludedPath('src/file.ts'), false);
    assert.strictEqual(isExcludedPath('app/main.py'), false);
  });

  // 3. Mock workspace for deterministic scoring & budget testing
  const mockFiles: Record<string, string> = {
    'src/auth.ts': 'export function validateToken(t: string) { return t.length > 0; }',
    'src/user.ts': 'import { validateToken } from "./auth"; export class User {}',
    'src/other.ts': 'export const irrelevant = 42;\n'.repeat(50),
    'docs/readme.md': '# Project Readme\nExplains how auth works.',
  };

  const mockFileReader = async (absPath: string) => {
    for (const [rel, content] of Object.entries(mockFiles)) {
      if (absPath.replace(/\\/g, '/').endsWith(rel)) {
        return content;
      }
    }
    return null;
  };

  const mockDirLister = async (absDir: string) => {
    if (absDir.endsWith('src')) {
      return ['auth.ts', 'user.ts', 'other.ts'];
    }
    if (absDir.endsWith('docs')) {
      return ['readme.md'];
    }
    return ['src', 'docs'];
  };

  const mockIsDir = async (absPath: string) => {
    const norm = absPath.replace(/\\/g, '/');
    return norm.endsWith('/src') || norm.endsWith('/docs') || norm === '/mock/workspace';
  };

  await runTest('assembleContext: deterministic scoring prioritizes explicit @file and @symbol', async () => {
    const result = await assembleContext({
      workspaceRoot: '/mock/workspace',
      prompt: 'Check @file:src/auth.ts for @symbol:validateToken',
      fileReader: mockFileReader,
      dirLister: mockDirLister,
      isDir: mockIsDir,
      budgetChars: 10000,
    });

    assert.ok(result.items.length >= 1);
    const topItem = result.items[0];
    assert.strictEqual(topItem.path, 'src/auth.ts');
    assert.ok(topItem.score >= 1800); // 1000 for @file + 800 for @symbol
    assert.ok(topItem.reasons.some((r) => r.includes('explicit @file match')));
    assert.ok(topItem.reasons.some((r) => r.includes('symbol')));
  });

  await runTest('assembleContext: active editor file receives priority boost', async () => {
    const result = await assembleContext({
      workspaceRoot: '/mock/workspace',
      prompt: 'Refactor the user logic',
      activeFilePath: '/mock/workspace/src/user.ts',
      activeFileContent: mockFiles['src/user.ts'],
      fileReader: mockFileReader,
      dirLister: mockDirLister,
      isDir: mockIsDir,
      budgetChars: 10000,
    });

    assert.ok(result.items.length >= 1);
    const topItem = result.items[0];
    assert.strictEqual(topItem.path, 'src/user.ts');
    assert.ok(topItem.reasons.some((r) => r.includes('active editor file')));
  });

  await runTest('assembleContext: strictly enforces character budget with truncation and omittedCount', async () => {
    // Tight budget of 500 characters
    const result = await assembleContext({
      workspaceRoot: '/mock/workspace',
      prompt: 'Find all information about other and auth and user',
      fileReader: mockFileReader,
      dirLister: mockDirLister,
      isDir: mockIsDir,
      budgetChars: 500,
    });

    assert.ok(result.usedChars <= 500, `usedChars ${result.usedChars} should be <= 500`);
    assert.ok(result.items.length > 0);
    // At least one item should be truncated or omitted given the tight budget
    const hasTruncated = result.items.some((it) => it.truncated);
    assert.ok(hasTruncated || result.omittedCount > 0);

    // Verify report format
    assert.ok(result.report.includes('--- Context Assembly Report ---'));
    assert.ok(result.report.includes('Budget: 500 chars'));
    assert.ok(result.report.includes('-------------------------------'));
  });

  await runTest('assembleContext: formattedPrompt formats structured workspace context envelope', async () => {
    const result = await assembleContext({
      workspaceRoot: '/mock/workspace',
      prompt: 'Check @file:src/auth.ts',
      fileReader: mockFileReader,
      dirLister: mockDirLister,
      isDir: mockIsDir,
      budgetChars: 5000,
    });

    assert.ok(result.formattedPrompt.includes('<workspace_context>'));
    assert.ok(result.formattedPrompt.includes('--- File: src/auth.ts ---'));
    assert.ok(result.formattedPrompt.includes('</workspace_context>'));
  });

  // 4. Regex Symbol Extraction
  await runTest('extractDeclaredSymbols: extracts symbols from Python def, async def, and class', () => {
    const pyCode = [
      'class AppConfig:',
      '    pass',
      'def get_debug_flag() -> bool:',
      '    return False',
      'async def fetch_remote():',
      '    pass',
    ].join('\n');
    const symbols = extractDeclaredSymbols(pyCode, 'server.py');
    const names = symbols.map((s) => s.name);
    assert.deepStrictEqual(names, ['AppConfig', 'get_debug_flag', 'fetch_remote']);
    assert.strictEqual(symbols[0].kind, 'class');
    assert.strictEqual(symbols[0].line, 1);
    assert.strictEqual(symbols[1].kind, 'function');
    assert.strictEqual(symbols[1].line, 3);
  });

  await runTest('extractDeclaredSymbols: extracts symbols from TS/JS functions, classes, interfaces, types, and consts', () => {
    const tsCode = [
      'export interface UserConfig { id: string; }',
      'export type UserRole = "admin" | "user";',
      'export class UserManager {}',
      'export function getUser() {}',
      'export const DEFAULT_TIMEOUT = 5000;',
    ].join('\n');
    const symbols = extractDeclaredSymbols(tsCode, 'user.ts');
    const names = symbols.map((s) => s.name);
    assert.deepStrictEqual(names, ['UserConfig', 'UserRole', 'UserManager', 'getUser', 'DEFAULT_TIMEOUT']);
    assert.strictEqual(symbols[0].kind, 'interface');
    assert.strictEqual(symbols[1].kind, 'type');
    assert.strictEqual(symbols[2].kind, 'class');
    assert.strictEqual(symbols[3].kind, 'function');
    assert.strictEqual(symbols[4].kind, 'variable');
  });

  // 5. Symbol definition matching in assembleContext
  await runTest('assembleContext: prompt matches declared symbol definitions with explicit "defines symbol" reason', async () => {
    const pythonMockFiles: Record<string, string> = {
      'src/app/utils.py': 'def get_debug_flag() -> bool:\n    return False\n',
      'src/app/main.py': '# imports utils\nclass AppServer:\n    pass\n',
    };
    const result = await assembleContext({
      workspaceRoot: '/mock/workspace',
      prompt: 'Check get_debug_flag',
      fileReader: async (abs: string) => {
        for (const [k, v] of Object.entries(pythonMockFiles)) {
          if (abs.replace(/\\/g, '/').endsWith(k)) return v;
        }
        return null;
      },
      dirLister: async (absDir: string) => {
        const norm = absDir.replace(/\\/g, '/');
        if (norm.endsWith('/src/app')) return ['utils.py', 'main.py'];
        if (norm.endsWith('/src')) return ['app'];
        return ['src'];
      },
      isDir: async (absPath: string) => {
        const norm = absPath.replace(/\\/g, '/');
        return norm.endsWith('/src') || norm.endsWith('/src/app') || norm === '/mock/workspace';
      },
      budgetChars: 10000,
    });

    const utilsItem = result.items.find((it) => it.path.includes('utils.py'));
    assert.ok(utilsItem, 'utils.py should be included');
    assert.ok(
      utilsItem.reasons.some((r) => r.includes("defines symbol 'get_debug_flag'")),
      `Expected reason "defines symbol 'get_debug_flag'", got: ${utilsItem.reasons.join(', ')}`
    );
  });

  // 6. 1-hop local dependency graph expansion (Python & TS)
  await runTest('assembleContext: 1-hop Python import graph boosts target file with "imported by" reason', async () => {
    const pyImportFiles: Record<string, string> = {
      'src/app/runner.py': 'from .utils import get_debug_flag\ndef runner_main(): pass\n',
      'src/app/utils.py': 'def get_debug_flag(): return False\n',
    };
    const result = await assembleContext({
      workspaceRoot: '/mock/workspace',
      prompt: 'Update the runner_main command',
      fileReader: async (abs: string) => {
        for (const [k, v] of Object.entries(pyImportFiles)) {
          if (abs.replace(/\\/g, '/').endsWith(k)) return v;
        }
        return null;
      },
      dirLister: async (absDir: string) => {
        const norm = absDir.replace(/\\/g, '/');
        if (norm.endsWith('/src/app')) return ['runner.py', 'utils.py'];
        if (norm.endsWith('/src')) return ['app'];
        return ['src'];
      },
      isDir: async (absPath: string) => {
        const norm = absPath.replace(/\\/g, '/');
        return norm.endsWith('/src') || norm.endsWith('/src/app') || norm === '/mock/workspace';
      },
      budgetChars: 10000,
    });

    const utilsItem = result.items.find((it) => it.path.includes('utils.py'));
    assert.ok(utilsItem, 'utils.py should be boosted into context');
    assert.ok(
      utilsItem.reasons.some((r) => r.includes('imported by')),
      `Expected "imported by" reason, got: ${utilsItem.reasons.join(', ')}`
    );
  });

  await runTest('assembleContext: 1-hop TypeScript import graph boosts imported file with "imported by" reason', async () => {
    const tsImportFiles: Record<string, string> = {
      'src/controller.ts': 'import { UserService } from "./service";\nexport class Controller {}\n',
      'src/service.ts': 'export class UserService {}\n',
    };
    const result = await assembleContext({
      workspaceRoot: '/mock/workspace',
      prompt: 'Check the Controller implementation',
      fileReader: async (abs: string) => {
        for (const [k, v] of Object.entries(tsImportFiles)) {
          if (abs.replace(/\\/g, '/').endsWith(k)) return v;
        }
        return null;
      },
      dirLister: async (absDir: string) => {
        const norm = absDir.replace(/\\/g, '/');
        if (norm.endsWith('/src')) return ['controller.ts', 'service.ts'];
        return ['src'];
      },
      isDir: async (absPath: string) => {
        const norm = absPath.replace(/\\/g, '/');
        return norm.endsWith('/src') || norm === '/mock/workspace';
      },
      budgetChars: 10000,
    });

    const serviceItem = result.items.find((it) => it.path.includes('service.ts'));
    assert.ok(serviceItem, 'service.ts should be boosted into context');
    assert.ok(
      serviceItem.reasons.some((r) => r.includes('imported by src/controller.ts')),
      `Expected "imported by src/controller.ts" reason, got: ${serviceItem.reasons.join(', ')}`
    );
  });

  // 7. Context Assembly Report displays budget usage %, reasons, and excluded/omitted counts
  await runTest('assembleContext: report displays used %, reasons, and excluded/omitted counts', async () => {
    const result = await assembleContext({
      workspaceRoot: '/mock/workspace',
      prompt: 'Check @file:src/auth.ts for @symbol:validateToken',
      fileReader: mockFileReader,
      dirLister: mockDirLister,
      isDir: mockIsDir,
      budgetChars: 10000,
    });

    assert.ok(result.report.includes('Budget: 10,000 chars'));
    assert.ok(result.report.includes('%'));
    assert.ok(result.report.includes('Omitted files:'));
    assert.ok(result.report.includes('Excluded files:'));
  });

  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.error('\nONE OR MORE CONTEXT CHECKS FAILED');
    process.exit(1);
  } else {
    console.log('\nALL CONTEXT CHECKS PASSED.');
    process.exit(0);
  }
}

void main();
