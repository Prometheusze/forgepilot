// src/mcp/checks.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleReadFile,
  handleSearchWorkspace,
  handleRunTerminalCommand,
  handleGetSymbols,
  isWorkspaceSubdirectory,
  detectShellFileWriteBypass,
} from './tools.js';
import { startMcpServer } from './server.js';
import * as http from 'node:http';

async function runChecks(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forgepilot-mcp-check-'));
  console.log(`MCP checks running against tempDir: ${tempDir}`);

  let allPassed = true;

  try {
    // -------------------------------------------------------------------------
    // Check 1: Generated 3,000,000-character single-line temp file
    // -------------------------------------------------------------------------
    const hugeFilePath = path.join(tempDir, 'huge-single-line.txt');
    const hugeBuffer = Buffer.alloc(3000000, 'x');
    fs.writeFileSync(hugeFilePath, hugeBuffer);

    const res1 = await handleReadFile({ path: 'huge-single-line.txt' }, tempDir);
    const text1 = res1.content[0]?.text ?? '';
    const pass1 = !res1.isError && text1.length <= 16000;
    if (!pass1) {
      allPassed = false;
      console.error(`FAIL: 3,000,000-character single-line file returned length ${text1.length} (isError=${res1.isError})`);
    } else {
      console.log(`PASS: 3,000,000-character single-line temp file -> response length ${text1.length} <= 16,000 chars`);
    }

    // -------------------------------------------------------------------------
    // Check 2: 1,000-line temp file -> at most 400 lines returned
    // -------------------------------------------------------------------------
    const thousandLinesPath = path.join(tempDir, 'thousand-lines.txt');
    const thousandLinesContent = Array.from({ length: 1000 }, (_, i) => `line ${i + 1} content here`).join('\n');
    fs.writeFileSync(thousandLinesPath, thousandLinesContent, 'utf-8');

    const res2 = await handleReadFile({ path: 'thousand-lines.txt' }, tempDir);
    const text2 = res2.content[0]?.text ?? '';
    const contentLines2 = text2.split('\n').filter((l) => /^\d+:\s/.test(l));
    const pass2 = !res2.isError && contentLines2.length <= 400 && contentLines2.length > 0;
    if (!pass2) {
      allPassed = false;
      console.error(`FAIL: 1,000-line temp file returned ${contentLines2.length} lines (expected at most 400)`);
    } else {
      console.log(`PASS: 1,000-line temp file -> at most 400 lines returned (${contentLines2.length} lines)`);
    }

    // -------------------------------------------------------------------------
    // Check 3: Search over temp tree containing node_modules and a .min.js file
    // -------------------------------------------------------------------------
    const nmDir = path.join(tempDir, 'node_modules');
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(nmDir, { recursive: true });
    fs.mkdirSync(srcDir, { recursive: true });

    fs.writeFileSync(path.join(nmDir, 'ignored.js'), 'const target = "UNIQUE_TARGET_SYM";', 'utf-8');
    fs.writeFileSync(path.join(tempDir, 'bundle.min.js'), '/* minified */ const target = "UNIQUE_TARGET_SYM";', 'utf-8');
    fs.writeFileSync(path.join(srcDir, 'valid.js'), 'export const target = "UNIQUE_TARGET_SYM";', 'utf-8');

    const res3 = await handleSearchWorkspace({ query: 'UNIQUE_TARGET_SYM' }, tempDir);
    const text3 = res3.content[0]?.text ?? '';
    const foundValid = text3.includes('src/valid.js');
    const excludedNm = !text3.includes('node_modules');
    const excludedMin = !text3.includes('bundle.min.js');
    const pass3 = !res3.isError && foundValid && excludedNm && excludedMin;

    if (!pass3) {
      allPassed = false;
      console.error(`FAIL: Search results: foundValid=${foundValid}, excludedNm=${excludedNm}, excludedMin=${excludedMin}\nResponse: ${text3}`);
    } else {
      console.log('PASS: Search over temp tree containing node_modules and .min.js never returns those');
    }

    // -------------------------------------------------------------------------
    // Check 4: Missing workspace root is rejected
    // -------------------------------------------------------------------------
    const res4Read = await handleReadFile({ path: 'thousand-lines.txt' }, undefined);
    const res4Search = await handleSearchWorkspace({ query: 'test' }, undefined);
    const pass4 =
      res4Read.isError === true &&
      res4Read.content[0]?.text.includes('No workspace folder is open') &&
      res4Search.isError === true &&
      res4Search.content[0]?.text.includes('No workspace folder is open');

    if (!pass4) {
      allPassed = false;
      console.error(`FAIL: Missing workspace root was not properly rejected (read=${JSON.stringify(res4Read)}, search=${JSON.stringify(res4Search)})`);
    } else {
      console.log('PASS: Missing workspace root is rejected with tool error');
    }

    // -------------------------------------------------------------------------
    // Check 5: Run terminal command in tempDir executes and captures output
    // -------------------------------------------------------------------------
    const res5 = await handleRunTerminalCommand({ command: 'node -e "console.log(\'hello_terminal\')"' }, tempDir);
    const text5 = res5.content[0]?.text ?? '';
    const pass5 = !res5.isError && text5.includes('hello_terminal') && text5.includes('Exit code: 0');
    if (!pass5) {
      allPassed = false;
      console.error(`FAIL: Terminal command execution failed: ${text5}`);
    } else {
      console.log('PASS: Terminal command executes and captures stdout with exit code 0');
    }

    // -------------------------------------------------------------------------
    // Check 6: Terminal command rejects directory outside workspace root
    // -------------------------------------------------------------------------
    const res6 = await handleRunTerminalCommand({ command: 'node -v', cwd: '../outside_workspace' }, tempDir);
    const text6 = res6.content[0]?.text ?? '';
    const pass6 = res6.isError === true && text6.includes('outside the workspace root');
    if (!pass6) {
      allPassed = false;
      console.error(`FAIL: Path traversal in cwd was not rejected: ${text6}`);
    } else {
      console.log('PASS: Terminal command rejects cwd outside workspace root');
    }

    // -------------------------------------------------------------------------
    // Check 7: Windows case-insensitive path comparison (C:\ vs c:\)
    // -------------------------------------------------------------------------
    const winRoot = 'C:\\workspace\\project';
    const winChild = 'c:\\workspace\\project\\src';
    const isInside = isWorkspaceSubdirectory(winRoot, winChild);
    const winOutside = 'c:\\workspace\\other';
    const isOutside = !isWorkspaceSubdirectory(winRoot, winOutside);
    const pass7 = isInside && isOutside;
    if (!pass7) {
      allPassed = false;
      console.error(`FAIL: Windows case insensitivity check failed: inside=${isInside}, outside=${isOutside}`);
    } else {
      console.log('PASS: Windows case-insensitive cwd comparison handles drive letter casing');
    }

    // -------------------------------------------------------------------------
    // Check 8: get_symbols tool extracts declared symbols and enforces path guard
    // -------------------------------------------------------------------------
    const pyFilePath = path.join(tempDir, 'sample.py');
    fs.writeFileSync(
      pyFilePath,
      'def calculate_tax(amount):\n    return amount * 0.1\n\nclass TaxCalculator:\n    pass\n',
      'utf-8'
    );

    const res8 = await handleGetSymbols({ path: 'sample.py' }, tempDir);
    const text8 = res8.content[0]?.text ?? '';
    const pass8 =
      !res8.isError &&
      text8.includes('L1: function calculate_tax') &&
      text8.includes('L4: class TaxCalculator');

    const res8NotFound = await handleGetSymbols({ path: 'missing.py' }, tempDir);
    const pass8NotFound = res8NotFound.isError === true;

    const res8Outside = await handleGetSymbols({ path: '../outside.py' }, tempDir);
    const pass8Outside = res8Outside.isError === true;

    if (!pass8 || !pass8NotFound || !pass8Outside) {
      allPassed = false;
      console.error(`FAIL: get_symbols verification failed (pass=${pass8}, notFound=${pass8NotFound}, outside=${pass8Outside}): ${text8}`);
    } else {
      console.log('PASS: get_symbols tool extracts symbols with line numbers and guards path');
    }

    // -------------------------------------------------------------------------
    // Check 9: Concurrent MCP server startup auto-resolves port without EADDRINUSE
    // -------------------------------------------------------------------------
    const basePort = 19850;
    const srv1 = await startMcpServer(basePort);
    const srv2 = await startMcpServer(basePort);

    const pass9 = srv1.port === basePort && srv2.port !== basePort && srv2.port > 0;
    if (!pass9) {
      allPassed = false;
      console.error(`FAIL: Port fallback failed: srv1.port=${srv1.port}, srv2.port=${srv2.port}`);
    } else {
      console.log(`PASS: Port fallback auto-resolved port collision without EADDRINUSE (${srv1.port} -> ${srv2.port})`);
    }

    await srv1.dispose();
    await srv2.dispose();

    // -------------------------------------------------------------------------
    // Check 10: Scoped pacing applies only to tools/call, never to initialize or tools/list
    // -------------------------------------------------------------------------
    const pacedSrv = await startMcpServer(0, { toolCallPacingMs: 300 });
    const postJson = async (body: any) => {
      return new Promise<number>((resolve, reject) => {
        const payload = JSON.stringify(body);
        const req = http.request(
          pacedSrv.url,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json, text/event-stream',
              'Content-Length': Buffer.byteLength(payload),
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
      });
    };

    // 1. initialize request should be instant (< 150ms)
    const t0 = Date.now();
    await postJson({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    });
    const initElapsed = Date.now() - t0;

    // 2. tools/list request should also be instant (< 150ms)
    const t1 = Date.now();
    await postJson({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    });
    const listElapsed = Date.now() - t1;

    const pass10 = initElapsed < 250 && listElapsed < 250;
    if (!pass10) {
      allPassed = false;
      console.error(`FAIL: Non-tool request was unexpectedly delayed: init=${initElapsed}ms, list=${listElapsed}ms`);
    } else {
      console.log(`PASS: Scoped pacing does not delay initialize (${initElapsed}ms) or tools/list (${listElapsed}ms)`);
    }

    await pacedSrv.dispose();
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }

  if (allPassed) {
    
  // Diff-safety shell-write bypass checks
  const assertBypass = (cond: boolean, msg: string) => { if (!cond) throw new Error(msg); };
  const blockedCmds = [
    'echo hacked > tests/test_cli.py',
    'Set-Content foo.py "overwrite"',
    'python -c "open(\'a.py\', \'w\').write(\'x\')"',
    "sed -i 's/a/b/' src/app.py",
    'rm -f tests/test_cli.py',
  ];
  for (const cmd of blockedCmds) {
    const reason = detectShellFileWriteBypass(cmd);
    assertBypass(reason !== null, `Expected shell write bypass to be blocked: ${cmd}`);
    const res = await handleRunTerminalCommand({ command: cmd }, tempDir);
    assertBypass(res.isError === true, `Expected handleRunTerminalCommand to reject bypass: ${cmd}`);
    assertBypass(res.content[0].text.includes('propose_edit'), `Expected propose_edit guidance for: ${cmd}`);
  }
  const allowedCmds = [
    'pytest tests/test_cli.py -q',
    'python -m flask --help',
    'python -m flask config',
    'echo ok',
  ];
  for (const cmd of allowedCmds) {
    const reason = detectShellFileWriteBypass(cmd);
    assertBypass(reason === null, `Expected safe command to be allowed: ${cmd} (got ${reason})`);
  }
  console.log('PASS: run_terminal_command blocks shell file-write bypasses and allows safe test/CLI commands');

  console.log('ALL MCP CHECKS PASSED');
    process.exit(0);
  } else {
    console.error('ONE OR MORE MCP CHECKS FAILED');
    process.exit(1);
  }
}

void runChecks();
