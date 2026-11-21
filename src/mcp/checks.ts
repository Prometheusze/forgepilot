// src/mcp/checks.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleReadFile, handleSearchWorkspace } from './tools.js';

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
  } finally {
    // Clean up temp directory
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  }

  if (allPassed) {
    console.log('ALL MCP CHECKS PASSED');
    process.exit(0);
  } else {
    console.error('ONE OR MORE MCP CHECKS FAILED');
    process.exit(1);
  }
}

void runChecks();
