// src/review/decisionChecks.ts
import * as assert from 'node:assert';
import { DecisionStore, put, take, clear, AppliedDecisionOutcome } from './decisions.js';
import { canonicalKey, ProposeEditArgs } from './proposal.js';

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

console.log('=== Running Decision Store Checks ===\n');

runTest('DecisionStore: put and take retrieves stored outcome', () => {
  const store = new DecisionStore();
  const outcome: AppliedDecisionOutcome = {
    kind: 'applied',
    path: 'src/main.ts',
    acceptedHunkIds: [0, 1],
    rejectedHunkIds: [2],
    totalHunks: 3,
    saved: true,
  };

  store.put('test-key-1', outcome);
  const retrieved = store.take('test-key-1');
  assert.deepStrictEqual(retrieved, outcome);
});

runTest('DecisionStore: single-use enforcement (take removes entry)', () => {
  const store = new DecisionStore();
  const outcome: AppliedDecisionOutcome = {
    kind: 'applied',
    path: 'src/app.ts',
    acceptedHunkIds: [0],
    rejectedHunkIds: [],
    totalHunks: 1,
    saved: false,
  };

  store.put('single-use-key', outcome);
  const first = store.take('single-use-key');
  assert.deepStrictEqual(first, outcome);

  const second = store.take('single-use-key');
  assert.strictEqual(second, undefined);
});

runTest('DecisionStore: entry expires after 15 minutes with injectable clock', () => {
  let simulatedTime = 1_000_000;
  const store = new DecisionStore(() => simulatedTime);

  const outcome: AppliedDecisionOutcome = {
    kind: 'applied',
    path: 'src/index.ts',
    acceptedHunkIds: [0],
    rejectedHunkIds: [],
    totalHunks: 1,
    saved: true,
  };

  store.put('expiry-key', outcome);

  // Advance time by 14 minutes and 59 seconds (899,000 ms) -> still valid
  simulatedTime += 14 * 60 * 1000 + 59 * 1000;
  store.put('second-key', outcome);
  assert.deepStrictEqual(store.take('second-key'), outcome);

  // Advance by another 2 seconds -> simulatedTime is 901,000 ms from the start (> 15 minutes for expiry-key)
  simulatedTime += 2000;
  const expired = store.take('expiry-key');
  assert.strictEqual(expired, undefined);
});

runTest('DecisionStore: same key for reordered JSON retrieves decision', () => {
  const store = new DecisionStore();
  const args1: ProposeEditArgs = {
    path: 'src/config.ts',
    edits: [{ old_text: 'foo', new_text: 'bar' }],
    explanation: 'rename',
  };

  // Construct equivalent args with reordered properties
  const args2 = JSON.parse(
    JSON.stringify({
      explanation: 'rename',
      edits: [{ new_text: 'bar', old_text: 'foo' }],
      path: 'src/config.ts',
    })
  ) as ProposeEditArgs;

  const key1 = canonicalKey(args1);
  const key2 = canonicalKey(args2);
  assert.strictEqual(key1, key2);

  const outcome: AppliedDecisionOutcome = {
    kind: 'applied',
    path: 'src/config.ts',
    acceptedHunkIds: [0],
    rejectedHunkIds: [],
    totalHunks: 1,
    saved: true,
  };

  store.put(key1, outcome);
  const retrieved = store.take(key2);
  assert.deepStrictEqual(retrieved, outcome);
});

runTest('DecisionStore: singleton functions work and clear cleans up', () => {
  clear();
  const outcome: AppliedDecisionOutcome = {
    kind: 'applied',
    path: 'src/singleton.ts',
    acceptedHunkIds: [0],
    rejectedHunkIds: [],
    totalHunks: 1,
    saved: true,
  };

  put('singleton-key', outcome);
  const retrieved = take('singleton-key');
  assert.deepStrictEqual(retrieved, outcome);

  put('singleton-key-2', outcome);
  clear();
  assert.strictEqual(take('singleton-key-2'), undefined);
});

console.log(`\n=== Summary ===`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('\nALL DECISION CHECKS PASSED.');
}
