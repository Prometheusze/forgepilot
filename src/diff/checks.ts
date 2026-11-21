// src/diff/checks.ts
import { applyEdits, computeHunks, applySelectedHunks, hunkSummary, Hunk, TextEdit } from './patch.js';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function report(category: string, desc: string, pass: boolean, details?: string): void {
  totalTests++;
  if (pass) {
    passedTests++;
    console.log(`PASS [${category}]: ${desc}`);
  } else {
    failedTests++;
    console.error(`FAIL [${category}]: ${desc}${details ? ` -> ${details}` : ''}`);
  }
}

function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// -----------------------------------------------------------------------------
// Part 1: applyEdits Tests
// -----------------------------------------------------------------------------
function testApplyEdits(): void {
  const cat = 'applyEdits';

  // 1.1 Unique match
  {
    const orig = 'const x = 1;\nconst y = 2;\n';
    const edits: TextEdit[] = [{ oldText: 'const x = 1;', newText: 'const x = 10;' }];
    const res = applyEdits(orig, edits);
    report(cat, 'unique match replaces text', res.ok && res.text === 'const x = 10;\nconst y = 2;\n');
  }

  // 1.2 Not found
  {
    const orig = 'const x = 1;\n';
    const edits: TextEdit[] = [{ oldText: 'const z = 3;', newText: 'const z = 4;' }];
    const res = applyEdits(orig, edits);
    const pass = !res.ok && res.error === 'edit 0: old_text not found' && res.editIndex === 0;
    report(cat, 'not found returns error with editIndex', pass, JSON.stringify(res));
  }

  // 1.3 Ambiguous match
  {
    const orig = 'item\nitem\nitem\n';
    const edits: TextEdit[] = [{ oldText: 'item', newText: 'entry' }];
    const res = applyEdits(orig, edits);
    const pass =
      !res.ok &&
      res.error === 'edit 0: old_text matches 3 places; include more surrounding lines' &&
      res.editIndex === 0;
    report(cat, 'ambiguous match returns count and guidance', pass, JSON.stringify(res));
  }

  // 1.4 Overlapping edits
  {
    const orig = 'abcdefghij';
    const edits: TextEdit[] = [
      { oldText: 'cdef', newText: '111' },
      { oldText: 'efgh', newText: '222' },
    ];
    const res = applyEdits(orig, edits);
    const pass = !res.ok && res.error.includes('overlapping edits');
    report(cat, 'overlapping edits rejected', pass, JSON.stringify(res));
  }

  // 1.5 Empty oldText
  {
    const orig = 'some content';
    const edits: TextEdit[] = [{ oldText: '', newText: 'prefix' }];
    const res = applyEdits(orig, edits);
    const pass = !res.ok && res.error === 'edit 0: old_text is empty' && res.editIndex === 0;
    report(cat, 'empty oldText rejected', pass, JSON.stringify(res));
  }

  // 1.6 Multi-edit in one file applied against original positions
  {
    const orig = 'alpha beta gamma delta epsilon';
    const edits: TextEdit[] = [
      { oldText: 'delta', newText: 'FOUR' },
      { oldText: 'beta', newText: 'TWO' },
    ];
    const res = applyEdits(orig, edits);
    report(cat, 'multi-edit preserves positions', res.ok && res.text === 'alpha TWO gamma FOUR epsilon');
  }

  // 1.7 CRLF input normalisation
  {
    const orig = 'line1\r\nline2\r\nline3\r\n';
    const edits: TextEdit[] = [{ oldText: 'line2\r\n', newText: 'line2_mod\n' }];
    const res = applyEdits(orig, edits);
    report(cat, 'CRLF input normalised to LF', res.ok && res.text === 'line1\nline2_mod\nline3\n');
  }
}

// -----------------------------------------------------------------------------
// Part 2: Hand-written computeHunks / applySelectedHunks Cases
// -----------------------------------------------------------------------------
function testHandwrittenHunks(): void {
  const cat = 'handwrittenHunks';

  // 2.1 Single change
  {
    const orig = 'alpha\nbeta\ngamma\n';
    const prop = 'alpha\nBETA\ngamma\n';
    const hunks = computeHunks(orig, prop, 1);
    report(cat, 'single change hunks count === 1', hunks.length === 1);
    report(cat, 'single change select all', applySelectedHunks(orig, hunks, [0]) === prop);
    report(cat, 'single change select none', applySelectedHunks(orig, hunks, []) === orig);
  }

  // 2.2 Two separate changes (select first, second, both, none)
  {
    const orig = 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8\nL9\n';
    const prop = 'L1\nL2_mod\nL3\nL4\nL5\nL6\nL7\nL8_mod\nL9\n';
    const hunks = computeHunks(orig, prop, 1);
    report(cat, 'two separate changes yield 2 hunks', hunks.length === 2);

    const onlyFirst = applySelectedHunks(orig, hunks, [0]);
    report(
      cat,
      'select only first hunk',
      onlyFirst === 'L1\nL2_mod\nL3\nL4\nL5\nL6\nL7\nL8\nL9\n'
    );

    const onlySecond = applySelectedHunks(orig, hunks, [1]);
    report(
      cat,
      'select only second hunk',
      onlySecond === 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8_mod\nL9\n'
    );

    const both = applySelectedHunks(orig, hunks, [0, 1]);
    report(cat, 'select both hunks reproduces proposed', both === prop);

    const none = applySelectedHunks(orig, hunks, []);
    report(cat, 'select none reproduces original', none === orig);
  }

  // 2.3 Pure insertion at top
  {
    const orig = 'first\nsecond\n';
    const prop = 'header\nfirst\nsecond\n';
    const hunks = computeHunks(orig, prop, 0);
    report(cat, 'pure insertion at top has oldLines === 0 and oldStart === 0', hunks[0]?.oldLines === 0 && hunks[0]?.oldStart === 0);
    report(cat, 'pure insertion at top applied', applySelectedHunks(orig, hunks, [0]) === prop);
  }

  // 2.4 Pure insertion in middle
  {
    const orig = 'line1\nline3\n';
    const prop = 'line1\nline2\nline3\n';
    const hunks = computeHunks(orig, prop, 0);
    report(cat, 'pure insertion in middle has oldStart === 1', hunks[0]?.oldLines === 0 && hunks[0]?.oldStart === 1);
    report(cat, 'pure insertion in middle applied', applySelectedHunks(orig, hunks, [0]) === prop);
  }

  // 2.5 Pure insertion at end
  {
    const orig = 'line1\nline2\n';
    const prop = 'line1\nline2\nline3\n';
    const hunks = computeHunks(orig, prop, 0);
    report(cat, 'pure insertion at end has oldStart === 2', hunks[0]?.oldLines === 0 && hunks[0]?.oldStart === 2);
    report(cat, 'pure insertion at end applied', applySelectedHunks(orig, hunks, [0]) === prop);
  }

  // 2.6 Pure deletion
  {
    const orig = 'line1\ndelete_me\nline3\n';
    const prop = 'line1\nline3\n';
    const hunks = computeHunks(orig, prop, 1);
    report(cat, 'pure deletion applied', applySelectedHunks(orig, hunks, [0]) === prop);
  }

  // 2.7 Change on first line
  {
    const orig = 'old_first\nsecond\nthird\n';
    const prop = 'new_first\nsecond\nthird\n';
    const hunks = computeHunks(orig, prop, 1);
    report(cat, 'change on first line applied', applySelectedHunks(orig, hunks, [0]) === prop);
  }

  // 2.8 Change on last line
  {
    const orig = 'first\nsecond\nold_last\n';
    const prop = 'first\nsecond\nnew_last\n';
    const hunks = computeHunks(orig, prop, 1);
    report(cat, 'change on last line applied', applySelectedHunks(orig, hunks, [0]) === prop);
  }

  // 2.9 No trailing newline
  {
    const orig = 'alpha\nbeta';
    const prop = 'alpha\nBETA';
    const hunks = computeHunks(orig, prop, 1);
    const applied = applySelectedHunks(orig, hunks, [0]);
    report(cat, 'no trailing newline preserved', applied === prop && !applied.endsWith('\n'));
  }

  // 2.10 Empty original
  {
    const orig = '';
    const prop = 'created\nfile\n';
    const hunks = computeHunks(orig, prop, 1);
    report(cat, 'empty original to proposed', applySelectedHunks(orig, hunks, [0]) === prop);
    report(cat, 'empty original none selected', applySelectedHunks(orig, hunks, []) === orig);
  }

  // 2.11 Empty proposed
  {
    const orig = 'entire\nfile\ndeleted\n';
    const prop = '';
    const hunks = computeHunks(orig, prop, 1);
    report(cat, 'file deleted to empty proposed', applySelectedHunks(orig, hunks, [0]) === prop);
    report(cat, 'file deleted none selected', applySelectedHunks(orig, hunks, []) === orig);
  }

  // 2.12 Two adjacent changes
  {
    const orig = 'A\nB\nC\nD\n';
    const prop = 'A\nB_mod\nC_mod\nD\n';
    const hunks = computeHunks(orig, prop, 1);
    report(cat, 'adjacent changes applied', applySelectedHunks(orig, hunks, hunks.map((h) => h.id)) === prop);
  }

  // 2.13 Docstring + condition change shaped like a small Python function
  {
    const orig = [
      'def calculate_tax(subtotal, tax_rate):',
      '    """Compute the tax on a subtotal."""',
      '    if subtotal < 0:',
      '        raise ValueError("Subtotal cannot be negative")',
      '    return subtotal * tax_rate',
      '',
    ].join('\n');

    const prop = [
      'def calculate_tax(subtotal, tax_rate):',
      '    """Compute the tax on a subtotal with rounding."""',
      '    if subtotal <= 0:',
      '        return 0.0',
      '    return round(subtotal * tax_rate, 2)',
      '',
    ].join('\n');

    const hunks = computeHunks(orig, prop, 2);
    report(cat, 'python function diff computed', hunks.length > 0);
    report(cat, 'python function select all', applySelectedHunks(orig, hunks, hunks.map((h) => h.id)) === prop);
    report(cat, 'python function select none', applySelectedHunks(orig, hunks, []) === orig);
  }

  // 2.14 hunkSummary check
  {
    const testHunk: Hunk = {
      id: 0,
      oldStart: 10,
      oldLines: 5,
      newStart: 10,
      newLines: 7,
      lines: [' context', '-del', '+add1', '+add2', '+add3', ' context2'],
      header: '@@ -10,5 +10,7 @@',
    };
    const summary = hunkSummary(testHunk);
    report(cat, `hunkSummary format "${summary}"`, summary === 'lines 10-14: +3 -1');
  }
}

// -----------------------------------------------------------------------------
// Part 3: Deterministic Fuzz Test (Mulberry32 PRNG, 1,000 cases, context 0, 1, 3)
// -----------------------------------------------------------------------------
function testDeterministicFuzz(): void {
  const cat = 'deterministicFuzz';
  const SEED = 424242;
  const CASE_COUNT = 1000;
  console.log(`Fuzz test starting with seed=${SEED}, caseCount=${CASE_COUNT}, testing contextLines: [0, 1, 3]`);

  const rng = mulberry32(SEED);
  const vocabulary = ['apple', 'banana', 'cherry', 'date', 'elderberry', 'fig', 'grape', 'honeydew'];

  function randomText(): string {
    const lineCount = Math.floor(rng() * 12);
    if (lineCount === 0) {
      return '';
    }
    const lines: string[] = [];
    for (let i = 0; i < lineCount; i++) {
      lines.push(`${vocabulary[Math.floor(rng() * vocabulary.length)]}_${i}`);
    }
    const hasTrailingNewline = rng() > 0.4;
    return lines.join('\n') + (hasTrailingNewline ? '\n' : '');
  }

  function getLineCount(t: string): number {
    if (t.length === 0) return 0;
    const clean = t.endsWith('\n') ? t.slice(0, -1) : t;
    return clean.split('\n').length;
  }

  let failures = 0;

  for (let i = 0; i < CASE_COUNT; i++) {
    const orig = randomText();
    const prop = randomText();
    const origLineCount = getLineCount(orig);

    for (const ctx of [0, 1, 3]) {
      const hunks = computeHunks(orig, prop, ctx);

      // Property (a): selecting all hunks reproduces proposed exactly
      const allSelected = applySelectedHunks(orig, hunks, hunks.map((h) => h.id));
      if (allSelected !== prop) {
        failures++;
        report(cat, `Property (a) failed at case ${i} (ctx=${ctx})`, false, `diff mismatch`);
        break;
      }

      // Property (b): selecting none reproduces original exactly
      const noneSelected = applySelectedHunks(orig, hunks, []);
      if (noneSelected !== orig) {
        failures++;
        report(cat, `Property (b) failed at case ${i} (ctx=${ctx})`, false, `original mismatch`);
        break;
      }

      // Property (c): for each single hunk selected, resulting line count matches
      for (const h of hunks) {
        const singleSelected = applySelectedHunks(orig, hunks, [h.id]);
        const singleLineCount = getLineCount(singleSelected);
        const expectedCount = origLineCount + (h.newLines - h.oldLines);
        if (singleLineCount !== expectedCount) {
          failures++;
          report(
            cat,
            `Property (c) failed at case ${i} hunk ${h.id} (ctx=${ctx}): got ${singleLineCount}, expected ${expectedCount}`,
            false
          );
          break;
        }
      }

      // Property (d): random subset diff against original contains only lines from selected hunks
      if (hunks.length > 0) {
        const subset = hunks.filter(() => rng() > 0.5).map((h) => h.id);
        const subsetResult = applySelectedHunks(orig, hunks, subset);
        const diffAgainstOrig = computeHunks(orig, subsetResult, 0);

        const selectedSet = new Set(subset);
        const allowedAddedLines = new Set<string>();
        for (const h of hunks) {
          if (selectedSet.has(h.id)) {
            for (const l of h.lines) {
              if (l.startsWith('+')) {
                allowedAddedLines.add(l.slice(1));
              }
            }
          }
        }

        for (const dh of diffAgainstOrig) {
          for (const dl of dh.lines) {
            if (dl.startsWith('+') && !allowedAddedLines.has(dl.slice(1))) {
              failures++;
              report(cat, `Property (d) failed at case ${i}: unexpected added line "${dl}"`, false);
              break;
            }
          }
        }
      }
    }
  }

  report(
    cat,
    `1,000 deterministic fuzz cases across contextLines [0, 1, 3] (seed=${SEED})`,
    failures === 0
  );
}

// -----------------------------------------------------------------------------
// Runner
// -----------------------------------------------------------------------------
function runAll(): void {
  console.log('=== Running Diff & Patch Automated Test Suite ===\n');

  testApplyEdits();
  testHandwrittenHunks();
  testDeterministicFuzz();

  console.log('\n=== Summary ===');
  console.log(`Total checks: ${totalTests}`);
  console.log(`Passed: ${passedTests}`);
  console.log(`Failed: ${failedTests}`);

  if (failedTests > 0) {
    console.error(`\nFAILED: ${failedTests} test(s) failed.`);
    process.exit(1);
  } else {
    console.log(`\nALL ${passedTests} CHECKS PASSED.`);
    process.exit(0);
  }
}

runAll();
