// src/agent/toolResolveChecks.ts
import * as assert from 'node:assert';
import { resolveToolCall } from './toolResolve.js';

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
  console.log('=== Running Tool Resolve Checks ===\n');

  // Real log fixture shape
  const realArgsJson = JSON.stringify({
    path: 'src/extension.ts',
    edits: [{ old_text: 'const x = 1;', new_text: 'const x = 2;' }],
    explanation: 'update value',
  });

  const sourceEventId1 = '01m81b46989h5s6zca88ncb4eb';
  const callId1 = 'call_2869945862250445773';

  // 1. Found on first page
  await runTest('resolveToolCall: found on first page', async () => {
    const listEvents = async (cursor?: string) => {
      assert.strictEqual(cursor, undefined);
      return {
        events: [
          { type: 'turn.created', id: 'evt_0' },
          {
            type: 'model.message',
            id: sourceEventId1,
            threadId: 'main',
            toolCalls: [
              {
                id: callId1,
                type: 'function',
                function: {
                  name: 'forgepilot-editor_propose_edit',
                  arguments: realArgsJson,
                },
              },
            ],
          },
        ],
        nextAfterEventId: null,
      };
    };

    const res = await resolveToolCall({ id: callId1, sourceEventId: sourceEventId1 }, listEvents);
    assert.ok(res);
    assert.strictEqual(res.name, 'forgepilot-editor_propose_edit');
    assert.strictEqual(res.argumentsJson, realArgsJson);
    assert.ok(res.rawEventJson.includes(sourceEventId1));
  });

  // 2. Found on second page (pagination)
  await runTest('resolveToolCall: found on second page (pagination)', async () => {
    const listEvents = async (cursor?: string) => {
      if (!cursor) {
        return {
          events: [
            { type: 'turn.created', id: 'evt_page1_0' },
            { type: 'turn.update', id: 'evt_page1_1' },
          ],
          nextAfterEventId: 'cursor_page_2',
        };
      }
      if (cursor === 'cursor_page_2') {
        return {
          events: [
            {
              type: 'model.message',
              id: sourceEventId1,
              threadId: 'main',
              toolCalls: [
                {
                  id: callId1,
                  type: 'function',
                  function: {
                    name: 'propose_edit',
                    arguments: realArgsJson,
                  },
                },
              ],
            },
          ],
          nextAfterEventId: null,
        };
      }
      return { events: [], nextAfterEventId: null };
    };

    const res = await resolveToolCall({ id: callId1, sourceEventId: sourceEventId1 }, listEvents);
    assert.ok(res);
    assert.strictEqual(res.name, 'propose_edit');
    assert.strictEqual(res.argumentsJson, realArgsJson);
  });

  // 3. snake_case variant
  await runTest('resolveToolCall: snake_case variant', async () => {
    const listEvents = async () => {
      return {
        events: [
          {
            type: 'model.message',
            id: 'evt_snake_1',
            thread_id: 'main',
            tool_calls: [
              {
                id: 'call_snake_1',
                type: 'function',
                function: {
                  name: 'propose_edit',
                  arguments: '{"path":"test.ts","edits":[]}',
                },
              },
            ],
          },
        ],
        nextAfterEventId: null,
      };
    };

    const res = await resolveToolCall(
      { id: 'call_snake_1', sourceEventId: 'evt_snake_1' },
      listEvents
    );
    assert.ok(res);
    assert.strictEqual(res.name, 'propose_edit');
    assert.strictEqual(res.argumentsJson, '{"path":"test.ts","edits":[]}');
  });

  // 4. Not found -> undefined
  await runTest('resolveToolCall: event not found returns undefined', async () => {
    const listEvents = async () => {
      return {
        events: [{ type: 'model.message', id: 'other_evt', toolCalls: [] }],
        nextAfterEventId: null,
      };
    };

    const res = await resolveToolCall({ id: callId1, sourceEventId: sourceEventId1 }, listEvents);
    assert.strictEqual(res, undefined);
  });

  // 5. Event found but call id missing -> undefined
  await runTest('resolveToolCall: event found but call id missing returns undefined', async () => {
    const listEvents = async () => {
      return {
        events: [
          {
            type: 'model.message',
            id: sourceEventId1,
            threadId: 'main',
            toolCalls: [
              {
                id: 'different_call_id',
                type: 'function',
                function: { name: 'read_file', arguments: '{}' },
              },
            ],
          },
        ],
        nextAfterEventId: null,
      };
    };

    const res = await resolveToolCall({ id: callId1, sourceEventId: sourceEventId1 }, listEvents);
    assert.strictEqual(res, undefined);
  });

  // 6. Arguments returned verbatim as a JSON string
  await runTest('resolveToolCall: arguments returned verbatim as a JSON string', async () => {
    const exactArgumentsString = '{"path":"a/b/c.ts","edits":[{"old_text":"  foo\\n","new_text":"  bar\\n"}]}';
    const listEvents = async () => {
      return {
        events: [
          {
            type: 'model.message',
            id: 'evt_verbatim',
            toolCalls: [
              {
                id: 'call_verbatim',
                type: 'function',
                function: {
                  name: 'propose_edit',
                  arguments: exactArgumentsString,
                },
              },
            ],
          },
        ],
        nextAfterEventId: null,
      };
    };

    const res = await resolveToolCall(
      { id: 'call_verbatim', sourceEventId: 'evt_verbatim' },
      listEvents
    );
    assert.ok(res);
    assert.strictEqual(res.argumentsJson, exactArgumentsString);
  });

  console.log(`\n=== Summary ===`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  } else {
    console.log('\nALL TOOL RESOLVE CHECKS PASSED.');
  }
}

void main();
