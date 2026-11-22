// src/review/checks.ts
import * as assert from 'node:assert';
import {
  parseProposeEditArgs,
  canonicalKey,
  buildProposal,
  computeContentHash,
  applyProposalSafely,
  ProposeEditArgs,
} from './proposal.js';
import { applySelectedHunks } from '../diff/patch.js';

let passed = 0;
let failed = 0;

function runTest(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS [${name}]`);
    passed++;
  } catch (err) {
    console.error(`FAIL [${name}]:`, err);
    failed++;
  }
}

console.log('=== Running Proposal & Review Logic Checks ===\n');

// 1. parseProposeEditArgs checks
runTest('parseProposeEditArgs: valid arguments', () => {
  const raw = {
    path: 'src/main.ts',
    edits: [{ old_text: 'foo', new_text: 'bar' }],
    explanation: 'rename foo to bar',
  };
  const res = parseProposeEditArgs(raw);
  assert.strictEqual(res.ok, true);
  if (res.ok) {
    assert.strictEqual(res.args.path, 'src/main.ts');
    assert.strictEqual(res.args.edits.length, 1);
    assert.strictEqual(res.args.edits[0].old_text, 'foo');
    assert.strictEqual(res.args.edits[0].new_text, 'bar');
    assert.strictEqual(res.args.explanation, 'rename foo to bar');
  }
});

runTest('parseProposeEditArgs: missing or empty path', () => {
  assert.strictEqual(parseProposeEditArgs({ path: '', edits: [{ old_text: 'a', new_text: 'b' }] }).ok, false);
  assert.strictEqual(parseProposeEditArgs({ path: '   ', edits: [{ old_text: 'a', new_text: 'b' }] }).ok, false);
  assert.strictEqual(parseProposeEditArgs({ edits: [{ old_text: 'a', new_text: 'b' }] }).ok, false);
});

runTest('parseProposeEditArgs: empty edits array', () => {
  const res = parseProposeEditArgs({ path: 'test.ts', edits: [] });
  assert.strictEqual(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /empty/i);
  }
});

runTest('parseProposeEditArgs: 21 edits rejected (> 20 limit)', () => {
  const edits = Array.from({ length: 21 }, (_, i) => ({
    old_text: `foo${i}`,
    new_text: `bar${i}`,
  }));
  const res = parseProposeEditArgs({ path: 'test.ts', edits });
  assert.strictEqual(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /exceeds maximum allowed edits/i);
  }
});

runTest('parseProposeEditArgs: 20 edits accepted', () => {
  const edits = Array.from({ length: 20 }, (_, i) => ({
    old_text: `foo${i}`,
    new_text: `bar${i}`,
  }));
  const res = parseProposeEditArgs({ path: 'test.ts', edits });
  assert.strictEqual(res.ok, true);
});

runTest('parseProposeEditArgs: oversized text rejected (> 50,000 characters)', () => {
  const hugeText = 'a'.repeat(50001);
  const resOld = parseProposeEditArgs({
    path: 'test.ts',
    edits: [{ old_text: hugeText, new_text: 'b' }],
  });
  assert.strictEqual(resOld.ok, false);
  if (!resOld.ok) {
    assert.match(resOld.error, /exceeds maximum length/i);
  }

  const resNew = parseProposeEditArgs({
    path: 'test.ts',
    edits: [{ old_text: 'a', new_text: hugeText }],
  });
  assert.strictEqual(resNew.ok, false);
  if (!resNew.ok) {
    assert.match(resNew.error, /exceeds maximum length/i);
  }
});

runTest('parseProposeEditArgs: wrong types', () => {
  assert.strictEqual(parseProposeEditArgs(null).ok, false);
  assert.strictEqual(parseProposeEditArgs(undefined).ok, false);
  assert.strictEqual(parseProposeEditArgs('string').ok, false);
  assert.strictEqual(parseProposeEditArgs([]).ok, false);
  assert.strictEqual(parseProposeEditArgs(123).ok, false);
  assert.strictEqual(parseProposeEditArgs({ path: 'test.ts', edits: 'not-an-array' }).ok, false);
  assert.strictEqual(
    parseProposeEditArgs({ path: 'test.ts', edits: [{ old_text: 123, new_text: 'b' }] }).ok,
    false
  );
  assert.strictEqual(
    parseProposeEditArgs({ path: 'test.ts', edits: [{ old_text: 'a', new_text: 456 }] }).ok,
    false
  );
  assert.strictEqual(
    parseProposeEditArgs({
      path: 'test.ts',
      edits: [{ old_text: 'a', new_text: 'b' }],
      explanation: 123 as unknown as string,
    }).ok,
    false
  );
});

// 2. canonicalKey checks
runTest('canonicalKey: same key for reordered object keys', () => {
  const obj1: ProposeEditArgs = {
    path: 'src/utils.ts',
    edits: [{ old_text: 'alpha', new_text: 'beta' }],
    explanation: 'test explanation',
  };

  // Construct equivalent object with different key insertion order
  const obj2 = JSON.parse(
    JSON.stringify({
      explanation: 'test explanation',
      edits: [{ new_text: 'beta', old_text: 'alpha' }],
      path: 'src/utils.ts',
    })
  ) as ProposeEditArgs;

  const key1 = canonicalKey(obj1);
  const key2 = canonicalKey(obj2);
  assert.strictEqual(key1, key2);
  assert.strictEqual(typeof key1, 'string');
  assert.strictEqual(key1.length, 64); // SHA-256 hex string
});

runTest('canonicalKey: different key for different edits', () => {
  const key1 = canonicalKey({
    path: 'src/utils.ts',
    edits: [{ old_text: 'alpha', new_text: 'beta' }],
  });
  const key2 = canonicalKey({
    path: 'src/utils.ts',
    edits: [{ old_text: 'alpha', new_text: 'gamma' }],
  });
  assert.notStrictEqual(key1, key2);
});

// 3. buildProposal checks
runTest('buildProposal: unique match produces hunks', () => {
  const currentText = 'function hello() {\n  console.log("hello");\n}\n';
  const args: ProposeEditArgs = {
    path: 'test.js',
    edits: [{ old_text: 'console.log("hello");', new_text: 'console.log("world");' }],
  };
  const res = buildProposal(currentText, args);
  assert.strictEqual(res.ok, true);
  if (res.ok) {
    assert.strictEqual(res.baseText, currentText);
    assert.strictEqual(res.proposedText.includes('console.log("world");'), true);
    assert.strictEqual(res.hunks.length, 1);
  }
});

runTest('buildProposal: not found returns error text', () => {
  const currentText = 'const x = 1;\n';
  const args: ProposeEditArgs = {
    path: 'test.js',
    edits: [{ old_text: 'const y = 2;', new_text: 'const y = 3;' }],
  };
  const res = buildProposal(currentText, args);
  assert.strictEqual(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /edit 0: old_text not found/);
  }
});

runTest('buildProposal: ambiguous match returns error', () => {
  const currentText = 'foo\nbar\nfoo\n';
  const args: ProposeEditArgs = {
    path: 'test.js',
    edits: [{ old_text: 'foo', new_text: 'baz' }],
  };
  const res = buildProposal(currentText, args);
  assert.strictEqual(res.ok, false);
  if (!res.ok) {
    assert.match(res.error, /matches 2 places/);
  }
});

runTest('buildProposal: no-op edit returns error ("edits produce no change")', () => {
  const currentText = 'line1\nline2\n';
  const args: ProposeEditArgs = {
    path: 'test.js',
    edits: [{ old_text: 'line1', new_text: 'line1' }],
  };
  const res = buildProposal(currentText, args);
  assert.strictEqual(res.ok, false);
  if (!res.ok) {
    assert.strictEqual(res.error, 'edits produce no change');
  }
});

runTest('buildProposal: CRLF input normalised to LF', () => {
  const currentText = 'line1\r\nline2\r\nline3\r\n';
  const args: ProposeEditArgs = {
    path: 'test.js',
    edits: [{ old_text: 'line2', new_text: 'modified' }],
  };
  const res = buildProposal(currentText, args);
  assert.strictEqual(res.ok, true);
  if (res.ok) {
    assert.strictEqual(res.baseText.includes('\r\n'), false);
    assert.strictEqual(res.baseText, 'line1\nline2\nline3\n');
    assert.strictEqual(res.proposedText, 'line1\nmodified\nline3\n');
    assert.strictEqual(res.hunks.length, 1);
  }
});

runTest('buildProposal: two distant edits produce 2 hunks; applying only second leaves first region untouched', () => {
  const lines: string[] = [];
  for (let i = 1; i <= 25; i++) {
    lines.push(`Line ${i}: initial content`);
  }
  const currentText = lines.join('\n') + '\n';

  const args: ProposeEditArgs = {
    path: 'test.txt',
    edits: [
      { old_text: 'Line 2: initial content', new_text: 'Line 2: first change' },
      { old_text: 'Line 22: initial content', new_text: 'Line 22: second change' },
    ],
  };

  const res = buildProposal(currentText, args);
  assert.strictEqual(res.ok, true);
  if (res.ok) {
    assert.strictEqual(res.hunks.length, 2);

    // Apply only the second hunk (hunk id 1)
    const partialApplied = applySelectedHunks(res.baseText, res.hunks, [res.hunks[1].id]);

    // First region must still have "Line 2: initial content"
    assert.strictEqual(partialApplied.includes('Line 2: initial content'), true);
    assert.strictEqual(partialApplied.includes('Line 2: first change'), false);

    // Second region must have "Line 22: second change"
    assert.strictEqual(partialApplied.includes('Line 22: second change'), true);
    assert.strictEqual(partialApplied.includes('Line 22: initial content'), false);
  }
});

// Stale Buffer & Concurrent Edit Protection checks
runTest('computeContentHash: CRLF and LF generate identical content hashes', () => {
  const lf = 'function test() {\n  return 42;\n}\n';
  const crlf = 'function test() {\r\n  return 42;\r\n}\r\n';
  assert.strictEqual(computeContentHash(lf), computeContentHash(crlf));
});

runTest('applyProposalSafely: applies selected hunks when base hash and version match', () => {
  const currentText = 'alpha\nbeta\ngamma\n';
  const args: ProposeEditArgs = {
    path: 'test.txt',
    edits: [{ old_text: 'beta', new_text: 'BETA' }],
  };
  const proposal = buildProposal(currentText, args, 1);
  assert.strictEqual(proposal.ok, true);
  if (proposal.ok) {
    const result = applyProposalSafely(currentText, proposal, [proposal.hunks[0].id], 1);
    assert.strictEqual(result.ok, true);
    if (result.ok) {
      assert.strictEqual(result.newText, 'alpha\nBETA\ngamma\n');
    }
  }
});

runTest('applyProposalSafely: rejects and returns conflict when content hash mismatches', () => {
  const initialText = 'alpha\nbeta\ngamma\n';
  const args: ProposeEditArgs = {
    path: 'test.txt',
    edits: [{ old_text: 'beta', new_text: 'BETA' }],
  };
  const proposal = buildProposal(initialText, args, 1);
  assert.strictEqual(proposal.ok, true);
  if (proposal.ok) {
    // Concurrent user edit modified the file before agent applied
    const modifiedText = 'alpha\nbeta_user_edited\ngamma\n';
    const result = applyProposalSafely(modifiedText, proposal, [proposal.hunks[0].id], 1);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.conflict, true);
      assert.match(result.reason, /Content hash mismatch/i);
    }
  }
});

runTest('applyProposalSafely: rejects and returns conflict when document version mismatches', () => {
  const currentText = 'alpha\nbeta\ngamma\n';
  const args: ProposeEditArgs = {
    path: 'test.txt',
    edits: [{ old_text: 'beta', new_text: 'BETA' }],
  };
  const proposal = buildProposal(currentText, args, 1);
  assert.strictEqual(proposal.ok, true);
  if (proposal.ok) {
    // Expected version 1, but editor version is now 2
    const result = applyProposalSafely(currentText, proposal, [proposal.hunks[0].id], 2);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.conflict, true);
      assert.match(result.reason, /Version mismatch/i);
    }
  }
});

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\nALL REVIEW CHECKS PASSED.');
}
