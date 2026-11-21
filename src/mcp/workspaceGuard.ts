// src/mcp/workspaceGuard.ts
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface GuardValidationSuccess {
  ok: true;
  fullPath: string;
  relativePath: string;
}

export interface GuardValidationFailure {
  ok: false;
  error: string;
}

export type GuardValidationResult = GuardValidationSuccess | GuardValidationFailure;

const DENIED_DIRECTORIES = new Set(['.git', 'node_modules', 'out', '.vscode-test']);

/**
 * Checks whether a path or its basename matches forbidden files or directories.
 */
export function isDeniedPathComponent(relPath: string): { denied: boolean; reason?: string } {
  const normalized = relPath.replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);

  for (const segment of segments) {
    if (DENIED_DIRECTORIES.has(segment)) {
      return { denied: true, reason: `Access to "${segment}" directory is forbidden.` };
    }
  }

  const basename = segments.length > 0 ? segments[segments.length - 1] : '';
  if (basename.startsWith('.env')) {
    return { denied: true, reason: `Access to environment configuration files ("${basename}") is forbidden.` };
  }
  if (basename.endsWith('.pem') || basename.endsWith('.key')) {
    return { denied: true, reason: `Access to certificate/key files ("${basename}") is forbidden.` };
  }

  return { denied: false };
}

/**
 * Checks whether a file is binary by scanning the first 8 KB for NUL bytes.
 */
export async function isBinaryFile(filePath: string): Promise<boolean> {
  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(filePath, 'r');
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await fd.read(buffer, 0, 8192, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0x00) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd) {
      await fd.close().catch(() => {});
    }
  }
}

/**
 * Validates that a requested path resolves inside the explicitly provided workspace root,
 * does not escape via traversal or symlinks, and does not touch forbidden directories or files.
 * Rejects with an error if workspaceRoot is missing (no process.cwd() fallback).
 */
export function validateWorkspacePath(
  targetPath: string,
  workspaceRoot?: string
): GuardValidationResult {
  if (!workspaceRoot || !workspaceRoot.trim()) {
    return { ok: false, error: 'No workspace folder is open.' };
  }

  if (!targetPath || typeof targetPath !== 'string') {
    return { ok: false, error: 'Path must be a non-empty string.' };
  }

  const root = path.resolve(workspaceRoot.trim());
  const resolved = path.resolve(root, targetPath);

  // Traversal check relative to root
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, error: `Access denied: "${targetPath}" resolves outside the workspace.` };
  }

  // Symlink escape check if path exists on disk
  try {
    if (fs.existsSync(resolved)) {
      const realResolved = fs.realpathSync(resolved);
      const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
      const relReal = path.relative(realRoot, realResolved);
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
        return { ok: false, error: `Access denied: "${targetPath}" resolves outside the workspace via symlink.` };
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to verify path realpath: ${message}` };
  }

  // Deny list check
  const deniedCheck = isDeniedPathComponent(rel);
  if (deniedCheck.denied) {
    return { ok: false, error: `Access denied: ${deniedCheck.reason}` };
  }

  return {
    ok: true,
    fullPath: resolved,
    relativePath: rel.replace(/\\/g, '/'),
  };
}

// Standalone self-test runner for verification
if (require.main === module) {
  const root = process.cwd();
  console.log(`Running workspaceGuard verification against root: ${root}`);

  const testCases: Array<{ input: string; customRoot?: string; expectedOk: boolean; desc: string }> = [
    { input: '../x', customRoot: root, expectedOk: false, desc: 'Path traversal "../x"' },
    { input: 'C:/some_outside_dir/file.txt', customRoot: root, expectedOk: false, desc: 'Absolute path outside workspace' },
    { input: '.env', customRoot: root, expectedOk: false, desc: 'Forbidden file ".env"' },
    { input: '.env.local', customRoot: root, expectedOk: false, desc: 'Forbidden file ".env.local"' },
    { input: 'node_modules/x', customRoot: root, expectedOk: false, desc: 'Forbidden directory "node_modules/x"' },
    { input: '.git/config', customRoot: root, expectedOk: false, desc: 'Forbidden directory ".git/config"' },
    { input: 'out/extension.js', customRoot: root, expectedOk: false, desc: 'Forbidden directory "out/extension.js"' },
    { input: 'secret.pem', customRoot: root, expectedOk: false, desc: 'Forbidden file "secret.pem"' },
    { input: 'src/extension.ts', customRoot: root, expectedOk: true, desc: 'Valid workspace file "src/extension.ts"' },
    { input: 'src/extension.ts', customRoot: undefined, expectedOk: false, desc: 'Missing workspace root rejected' },
  ];

  let allPassed = true;
  for (const tc of testCases) {
    const res = validateWorkspacePath(tc.input, tc.customRoot);
    const passed = res.ok === tc.expectedOk;
    if (!passed) {
      allPassed = false;
    }
    console.log(
      `${passed ? 'PASS' : 'FAIL'}: ${tc.desc} -> ok=${res.ok}${!res.ok ? ` (${res.error})` : ` (${res.relativePath})`}`
    );
  }

  if (allPassed) {
    console.log('ALL WORKSPACE GUARD CHECKS PASSED');
    process.exit(0);
  } else {
    console.error('SOME WORKSPACE GUARD CHECKS FAILED');
    process.exit(1);
  }
}
