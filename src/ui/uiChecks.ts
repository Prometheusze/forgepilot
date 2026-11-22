// src/ui/uiChecks.ts
import * as assert from 'node:assert';
import {
  createInitialUiState,
  reduceUiState,
  UiEventBus,
  MAX_STREAM_CHARS,
  ForgePilotUiState,
} from './eventBus.js';

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

console.log('=== Running ForgePilot UI State & EventBus Checks ===\n');

// 1. Initial State
runTest('uiEventBus: initial state is idle with expected defaults', () => {
  const state = createInitialUiState();
  assert.strictEqual(state.generation, 0);
  assert.strictEqual(state.mode, 'idle');
  assert.strictEqual(state.status, 'idle');
  assert.strictEqual(state.activeModel, null);
  assert.strictEqual(state.sessionId, null);
  assert.strictEqual(state.contextReport, null);
  assert.strictEqual(state.toolCalls.length, 0);
  assert.strictEqual(state.fallbackEvents.length, 0);
  assert.strictEqual(state.streamText, '');
  assert.ok(state.contextEngineering.includes('compaction'));
  assert.ok(state.contextEngineering.includes('large_tool_response'));
  assert.ok(state.contextEngineering.includes('deferred: get_symbols'));
});

// 2. runStart transitions
runTest('uiEventBus: runStart transitions state to running and resets prior stream/tools', () => {
  const initial = createInitialUiState();
  initial.streamText = 'stale previous output';
  initial.toolCalls = [{ id: '1', name: 'search_workspace', target: 'foo', status: 'done' }];

  const next = reduceUiState(initial, {
    type: 'runStart',
    generation: 1,
    mode: 'agent',
    prompt: 'Implement new feature',
    model: 'primary-model',
  });

  assert.strictEqual(next.generation, 1);
  assert.strictEqual(next.mode, 'agent');
  assert.strictEqual(next.status, 'running');
  assert.strictEqual(next.prompt, 'Implement new feature');
  assert.strictEqual(next.activeModel, 'primary-model');
  assert.strictEqual(next.streamText, '');
  assert.strictEqual(next.toolCalls.length, 0);
});

// 3. contextAssembled stores report
runTest('uiEventBus: contextAssembled populates contextReport', () => {
  const state = createInitialUiState();
  const next = reduceUiState(state, {
    type: 'contextAssembled',
    generation: 1,
    report: {
      budgetChars: 24000,
      usedChars: 12000,
      omittedCount: 2,
      items: [
        {
          path: 'src/utils.py',
          score: 1800,
          chars: 400,
          truncated: false,
          reasons: ['explicit @file match', "defines symbol 'test'"],
        },
      ],
    },
  });

  assert.ok(next.contextReport);
  assert.strictEqual(next.contextReport.budgetChars, 24000);
  assert.strictEqual(next.contextReport.usedChars, 12000);
  assert.strictEqual(next.contextReport.omittedCount, 2);
  assert.strictEqual(next.contextReport.items[0].score, 1800);
});

// 4. sessionCreated updates activeModel and sessionId
runTest('uiEventBus: sessionCreated updates activeModel and sessionId', () => {
  const state = createInitialUiState();
  const next = reduceUiState(state, {
    type: 'sessionCreated',
    generation: 1,
    sessionId: 'sess_12345',
    model: 'gemini-3-5-flash',
  });

  assert.strictEqual(next.sessionId, 'sess_12345');
  assert.strictEqual(next.activeModel, 'gemini-3-5-flash');
});

// 5. toolCall lifecycle
runTest('uiEventBus: toolCall lifecycle tracks running -> awaiting_approval -> approved -> done', () => {
  let state = createInitialUiState();

  // 1. Tool call started
  state = reduceUiState(state, {
    type: 'toolCall',
    generation: 1,
    id: 'call_1',
    name: 'read_file',
    target: 'src/main.ts',
    status: 'running',
  });
  assert.strictEqual(state.toolCalls.length, 1);
  assert.strictEqual(state.toolCalls[0].status, 'running');

  // 2. Propose edit awaiting approval
  state = reduceUiState(state, {
    type: 'toolCall',
    generation: 1,
    id: 'call_2',
    name: 'propose_edit',
    target: 'src/main.ts',
    status: 'awaiting_approval',
  });
  assert.strictEqual(state.toolCalls.length, 2);
  assert.strictEqual(state.toolCalls[1].status, 'awaiting_approval');
  assert.strictEqual(state.status, 'paused_approval');

  // 3. Tool approved
  state = reduceUiState(state, {
    type: 'toolApproval',
    generation: 1,
    id: 'call_2',
    status: 'approved',
  });
  assert.strictEqual(state.toolCalls[1].status, 'approved');
  assert.strictEqual(state.status, 'running');

  // 4. Tool done
  state = reduceUiState(state, {
    type: 'toolCall',
    generation: 1,
    id: 'call_2',
    name: 'propose_edit',
    target: 'src/main.ts',
    status: 'done',
  });
  assert.strictEqual(state.toolCalls[1].status, 'done');
});

// 6. modelFallback
runTest('uiEventBus: modelFallback records from/to models and classified reason', () => {
  let state = createInitialUiState();
  state = reduceUiState(state, {
    type: 'modelFallback',
    generation: 1,
    fromModel: 'primary-model',
    toModel: 'secondary-model',
    reason: 'HTTP 429 quota exhausted',
    category: 'rate_limit',
  });

  assert.strictEqual(state.status, 'fallback');
  assert.strictEqual(state.activeModel, 'secondary-model');
  assert.strictEqual(state.fallbackEvents.length, 1);
  assert.strictEqual(state.fallbackEvents[0].fromModel, 'primary-model');
  assert.strictEqual(state.fallbackEvents[0].toModel, 'secondary-model');
  assert.strictEqual(state.fallbackEvents[0].category, 'rate_limit');
});

// 7. streamDelta accumulation and truncation
runTest('uiEventBus: streamDelta accumulates text and caps at MAX_STREAM_CHARS', () => {
  let state = createInitialUiState();
  state = reduceUiState(state, {
    type: 'streamDelta',
    generation: 1,
    delta: 'Hello world! ',
  });
  state = reduceUiState(state, {
    type: 'streamDelta',
    generation: 1,
    delta: 'Second chunk.',
  });
  assert.strictEqual(state.streamText, 'Hello world! Second chunk.');

  // Huge chunk exceeding MAX_STREAM_CHARS
  const bigChunk = 'X'.repeat(MAX_STREAM_CHARS + 1000);
  state = reduceUiState(state, {
    type: 'streamDelta',
    generation: 1,
    delta: bigChunk,
  });
  assert.ok(state.streamText.length <= MAX_STREAM_CHARS + 50);
  assert.ok(state.streamText.startsWith('... [earlier output truncated]'));
});

// 8. Generation guard
runTest('uiEventBus: generation guard rejects events from older generation', () => {
  let state = createInitialUiState();
  state = reduceUiState(state, {
    type: 'runStart',
    generation: 2,
    mode: 'agent',
    prompt: 'Current run #2',
  });

  // Stale event from run #1 arrives late
  const staleState = reduceUiState(state, {
    type: 'streamDelta',
    generation: 1,
    delta: 'Stale chunk from run 1',
  });

  assert.strictEqual(staleState.streamText, '');
  assert.strictEqual(staleState.generation, 2);
});

// 9. Cancellation and error status transitions
runTest('uiEventBus: cancellation and error transitions record terminal status', () => {
  let state = createInitialUiState();
  state = reduceUiState(state, {
    type: 'runDone',
    generation: 1,
    status: 'cancelled',
  });
  assert.strictEqual(state.status, 'cancelled');

  state = reduceUiState(state, {
    type: 'runDone',
    generation: 1,
    status: 'error',
    errorMessage: 'TrueForge server not reachable',
  });
  assert.strictEqual(state.status, 'error');
  assert.strictEqual(state.errorMessage, 'TrueForge server not reachable');
});

// 10. UiEventBus subscriber receives state updates
runTest('uiEventBus: subscriber receives state snapshots on bus emit', () => {
  const bus = new UiEventBus();
  const received: ForgePilotUiState[] = [];

  const unsubscribe = bus.subscribe((s) => {
    received.push(s);
  });

  bus.emit({
    type: 'runStart',
    generation: 1,
    mode: 'inline',
    prompt: 'Fix bug',
  });
  bus.emit({
    type: 'streamDelta',
    generation: 1,
    delta: 'Fixed!',
  });

  unsubscribe();

  bus.emit({
    type: 'runDone',
    generation: 1,
    status: 'done',
  });

  assert.strictEqual(received.length, 2);
  assert.strictEqual(received[0].status, 'running');
  assert.strictEqual(received[1].streamText, 'Fixed!');
});

console.log('\n=== Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  console.error('\nONE OR MORE UI CHECKS FAILED');
  process.exit(1);
} else {
  console.log('\nALL UI CHECKS PASSED.');
  process.exit(0);
}
