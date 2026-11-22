// src/trueforge/fallbackChecks.ts
import * as assert from 'node:assert';
import { classifyError, executeWithFallback } from './fallbackRunner.js';

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
  console.log('=== Running Model Fallback & Resilience Checks ===\n');

  // 1. classifyError unit tests
  await runTest('classifyError: classifies ECONNREFUSED as network candidate', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:8790');
    (err as any).code = 'ECONNREFUSED';
    const c = classifyError(err);
    assert.strictEqual(c.isFallbackCandidate, true);
    assert.strictEqual(c.category, 'network');
    assert.ok(c.reason.includes('ECONNREFUSED'));
  });

  await runTest('classifyError: classifies HTTP 401 as auth candidate', () => {
    const err = new Error('Unauthorized');
    (err as any).statusCode = 401;
    const c = classifyError(err);
    assert.strictEqual(c.isFallbackCandidate, true);
    assert.strictEqual(c.category, 'auth');
    assert.ok(c.reason.includes('401'));
  });

  await runTest('classifyError: classifies timeout as timeout candidate', () => {
    const err = new Error('TrueForge request timed out connecting to http://localhost:8790');
    err.name = 'TrueForgeTimeoutError';
    const c = classifyError(err);
    assert.strictEqual(c.isFallbackCandidate, true);
    assert.strictEqual(c.category, 'timeout');
  });

  await runTest('classifyError: classifies terminal turn status "error" with concrete payload message', () => {
    const c = classifyError(new Error('Turn error'), 'error', 'Model provider quota exceeded');
    assert.strictEqual(c.isFallbackCandidate, true);
    assert.strictEqual(c.category, 'turn_error');
    assert.strictEqual(c.reason, 'Model provider quota exceeded');
  });

  await runTest('classifyError: strictly rejects user cancellation from fallback', () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    const c1 = classifyError(abortErr);
    assert.strictEqual(c1.isFallbackCandidate, false);
    assert.strictEqual(c1.category, 'cancelled');
    assert.strictEqual(c1.isRetryableSameModel, false);

    const c2 = classifyError(new Error('User cancelled run'), 'cancelled');
    assert.strictEqual(c2.isFallbackCandidate, false);
    assert.strictEqual(c2.category, 'cancelled');
    assert.strictEqual(c2.isRetryableSameModel, false);
  });

  await runTest('classifyError: classifies HTTP 422 as invalid_model (fast fallback candidate, not retryable)', () => {
    const err = new Error('Model google-gemini/unknown-model not found');
    (err as any).statusCode = 422;
    const c = classifyError(err);
    assert.strictEqual(c.isFallbackCandidate, true);
    assert.strictEqual(c.category, 'invalid_model');
    assert.strictEqual(c.isRetryableSameModel, false);
    assert.ok(c.reason.includes('422'));
  });

  await runTest('classifyError: classifies HTTP 429 and quota errors as rate_limit (retryable on same model)', () => {
    const err = new Error('Resource has been exhausted (e.g. check quota)');
    (err as any).statusCode = 429;
    const c = classifyError(err);
    assert.strictEqual(c.isFallbackCandidate, true);
    assert.strictEqual(c.category, 'rate_limit');
    assert.strictEqual(c.isRetryableSameModel, true);
  });

  // 2. executeWithFallback orchestration tests
  await runTest('executeWithFallback: primary succeeds on first try (no fallback)', async () => {
    let fallbackCalls = 0;
    const models = ['primary-model', 'secondary-model'];

    const result = await executeWithFallback(
      models,
      async (model, isFallback) => {
        assert.strictEqual(model, 'primary-model');
        assert.strictEqual(isFallback, false);
        return { answer: 'ok from primary' };
      },
      {
        onFallback: () => {
          fallbackCalls++;
        },
      }
    );

    assert.deepStrictEqual(result, { answer: 'ok from primary' });
    assert.strictEqual(fallbackCalls, 0);
  });

  await runTest('executeWithFallback: primary network error triggers automatic fallback to secondary', async () => {
    const models = ['primary-model', 'secondary-model'];
    const calledModels: string[] = [];
    const fallbacks: Array<{ from: string; to: string; reason: string }> = [];

    const result = await executeWithFallback(
      models,
      async (model, isFallback) => {
        calledModels.push(model);
        if (model === 'primary-model') {
          const err = new Error('connect ECONNREFUSED 127.0.0.1:8790');
          (err as any).code = 'ECONNREFUSED';
          throw err;
        }
        assert.strictEqual(isFallback, true);
        return { answer: 'recovered by secondary' };
      },
      {
        onFallback: (from, to, reason) => {
          fallbacks.push({ from, to, reason });
        },
      }
    );

    assert.deepStrictEqual(calledModels, ['primary-model', 'secondary-model']);
    assert.strictEqual(fallbacks.length, 1);
    assert.strictEqual(fallbacks[0].from, 'primary-model');
    assert.strictEqual(fallbacks[0].to, 'secondary-model');
    assert.ok(fallbacks[0].reason.includes('ECONNREFUSED'));
    assert.deepStrictEqual(result, { answer: 'recovered by secondary' });
  });

  await runTest('executeWithFallback: primary terminal turn error triggers automatic fallback to secondary', async () => {
    const models = ['model-a', 'model-b'];
    const calledModels: string[] = [];
    let fallbackNotified = false;

    const result = await executeWithFallback(
      models,
      async (model) => {
        calledModels.push(model);
        if (model === 'model-a') {
          return { status: 'error', errorMessage: 'Context window exceeded on model-a' };
        }
        return { status: 'done', answer: 'success from model-b' };
      },
      {
        onFallback: (from, to, reason) => {
          assert.strictEqual(from, 'model-a');
          assert.strictEqual(to, 'model-b');
          assert.strictEqual(reason, 'Context window exceeded on model-a');
          fallbackNotified = true;
        },
      }
    );

    assert.strictEqual(fallbackNotified, true);
    assert.deepStrictEqual(calledModels, ['model-a', 'model-b']);
    assert.strictEqual((result as any).status, 'done');
  });

  await runTest('executeWithFallback: all configured models fail -> throws clean aggregated error', async () => {
    const models = ['model-1', 'model-2'];
    let errorCaught: Error | null = null;

    try {
      await executeWithFallback(models, async (model) => {
        const err = new Error(`Failed on ${model}`);
        (err as any).statusCode = 500;
        throw err;
      });
    } catch (err: unknown) {
      errorCaught = err as Error;
    }

    assert.ok(errorCaught);
    assert.ok(errorCaught.message.includes('All configured models failed'));
    assert.ok(errorCaught.message.includes('model-1'));
    assert.ok(errorCaught.message.includes('model-2'));
  });

  await runTest('executeWithFallback: user cancellation on primary aborts immediately without secondary fallback', async () => {
    const models = ['model-1', 'model-2'];
    const calledModels: string[] = [];
    let errorCaught: Error | null = null;

    try {
      await executeWithFallback(models, async (model) => {
        calledModels.push(model);
        const cancelErr = new Error('User pressed cancel');
        cancelErr.name = 'AbortError';
        throw cancelErr;
      });
    } catch (err: unknown) {
      errorCaught = err as Error;
    }

    assert.ok(errorCaught);
    assert.strictEqual(errorCaught.name, 'AbortError');
    assert.deepStrictEqual(calledModels, ['model-1']); // model-2 was NEVER called!
  });

  await runTest('executeWithFallback: HTTP 422 triggers immediate fast fallback to secondary without primary retries', async () => {
    const models = ['invalid-primary', 'valid-secondary'];
    const invocations: string[] = [];
    let retryCalls = 0;
    let fallbackCalls = 0;

    const result = await executeWithFallback(
      models,
      async (model) => {
        invocations.push(model);
        if (model === 'invalid-primary') {
          const err = new Error('HTTP 422 Unprocessable Entity: model not supported');
          (err as any).statusCode = 422;
          throw err;
        }
        return { success: true, from: model };
      },
      {
        onRetry: () => {
          retryCalls++;
        },
        onFallback: () => {
          fallbackCalls++;
        },
        backoffDelaysMs: [10, 20],
        sleeper: async () => {},
      }
    );

    assert.deepStrictEqual(invocations, ['invalid-primary', 'valid-secondary']);
    assert.strictEqual(retryCalls, 0, 'Should not retry on 422');
    assert.strictEqual(fallbackCalls, 1, 'Should trigger exactly 1 fallback');
    assert.deepStrictEqual(result, { success: true, from: 'valid-secondary' });
  });

  await runTest('executeWithFallback: transient 429 retries with backoff and recovers without secondary fallback', async () => {
    const models = ['primary-model', 'secondary-model'];
    const invocations: string[] = [];
    let retryCount = 0;
    let fallbackCount = 0;
    const sleptMs: number[] = [];

    const result = await executeWithFallback(
      models,
      async (model) => {
        invocations.push(model);
        if (model === 'primary-model' && invocations.filter((m) => m === 'primary-model').length === 1) {
          const err = new Error('429 Too Many Requests: Rate limit exceeded');
          (err as any).statusCode = 429;
          throw err;
        }
        return { success: true, from: model };
      },
      {
        backoffDelaysMs: [50, 100],
        sleeper: async (ms) => {
          sleptMs.push(ms);
        },
        onRetry: () => {
          retryCount++;
        },
        onFallback: () => {
          fallbackCount++;
        },
      }
    );

    assert.deepStrictEqual(invocations, ['primary-model', 'primary-model']);
    assert.strictEqual(retryCount, 1);
    assert.strictEqual(fallbackCount, 0);
    assert.deepStrictEqual(sleptMs, [50]);
    assert.deepStrictEqual(result, { success: true, from: 'primary-model' });
  });

  await runTest('executeWithFallback: exhausted 429 retries cascade to secondary model', async () => {
    const models = ['rate-limited-primary', 'backup-secondary'];
    const invocations: string[] = [];
    let retryCount = 0;
    let fallbackCount = 0;

    const result = await executeWithFallback(
      models,
      async (model) => {
        invocations.push(model);
        if (model === 'rate-limited-primary') {
          const err = new Error('429 Rate limit exhausted');
          (err as any).statusCode = 429;
          throw err;
        }
        return { success: true, from: model };
      },
      {
        backoffDelaysMs: [10, 20],
        sleeper: async () => {},
        onRetry: () => {
          retryCount++;
        },
        onFallback: () => {
          fallbackCount++;
        },
      }
    );

    assert.deepStrictEqual(invocations, [
      'rate-limited-primary',
      'rate-limited-primary',
      'rate-limited-primary',
      'backup-secondary',
    ]);
    assert.strictEqual(retryCount, 2);
    assert.strictEqual(fallbackCount, 1);
    assert.deepStrictEqual(result, { success: true, from: 'backup-secondary' });
  });

  await runTest('executeWithFallback: cancellation during backoff sleep halts immediately without secondary fallback', async () => {
    const models = ['primary', 'secondary'];
    const invocations: string[] = [];
    let cancelled = false;
    let errorCaught: Error | null = null;

    try {
      await executeWithFallback(
        models,
        async (model) => {
          invocations.push(model);
          const err = new Error('429 Rate limit');
          (err as any).statusCode = 429;
          throw err;
        },
        {
          backoffDelaysMs: [500],
          isCancelled: () => cancelled,
          sleeper: async () => {
            // User cancels during sleep
            cancelled = true;
          },
        }
      );
    } catch (err: unknown) {
      errorCaught = err as Error;
    }

    assert.ok(errorCaught);
    assert.match(errorCaught.message, /cancelled/i);
    assert.deepStrictEqual(invocations, ['primary']); // secondary was NEVER called!
  });

  console.log('\n=== Summary ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    console.error('\nONE OR MORE FALLBACK CHECKS FAILED');
    process.exit(1);
  } else {
    console.log('\nALL FALLBACK CHECKS PASSED.');
    process.exit(0);
  }
}

void main();
