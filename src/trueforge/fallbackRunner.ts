// src/trueforge/fallbackRunner.ts

export interface ErrorClassification {
  isFallbackCandidate: boolean;
  category:
    | 'network'
    | 'auth'
    | 'http'
    | 'timeout'
    | 'turn_error'
    | 'rate_limit'
    | 'invalid_model'
    | 'cancelled'
    | 'unknown';
  reason: string;
  isRetryableSameModel: boolean;
}

export interface FallbackOptions {
  onFallback?: (fromModel: string, toModel: string, reason: string) => void | Promise<void>;
  onRetry?: (model: string, attempt: number, delayMs: number, reason: string) => void | Promise<void>;
  isCancelled?: () => boolean;
  log?: (message: string) => void;
  backoffDelaysMs?: number[];
  sleeper?: (ms: number) => Promise<void>;
}

/**
 * Classifies an error or terminal turn status into a structured classification.
 * Strictly guarantees that user cancellation / AbortError is NEVER marked as a fallback candidate.
 * Identifies HTTP 422 / unknown models for fast fallback (zero same-model retries),
 * and HTTP 429 / quota errors for exponential backoff retries.
 */
export function classifyError(
  err: unknown,
  turnStatus?: string,
  turnMessage?: string
): ErrorClassification {
  const baseError = err instanceof Error ? err : new Error(String(err));
  const errName = baseError.name || '';
  const errMsg = baseError.message || '';

  // 1. NEVER trigger fallback on user cancellation or AbortError
  const isAbort =
    errName === 'AbortError' ||
    errMsg.toLowerCase().includes('abort') ||
    errMsg.toLowerCase().includes('cancelled') ||
    turnStatus === 'cancelled';

  if (isAbort) {
    return {
      isFallbackCandidate: false,
      category: 'cancelled',
      reason: 'Operation cancelled by user',
      isRetryableSameModel: false,
    };
  }

  const errorObj = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: string;
    statusCode?: number;
    status?: number;
    cause?: { code?: string; message?: string };
  };
  const status = typeof errorObj.statusCode === 'number' ? errorObj.statusCode : errorObj.status;

  // 2. HTTP 422 Unprocessable Entity / Unknown or Invalid Model (fast fallback, 0 retries)
  const isInvalidModel =
    status === 422 ||
    errMsg.includes('422') ||
    errMsg.toLowerCase().includes('unknown model') ||
    errMsg.toLowerCase().includes('not found') ||
    errMsg.toLowerCase().includes('unsupported model') ||
    errMsg.toLowerCase().includes('model is not available') ||
    (turnMessage && (turnMessage.toLowerCase().includes('unknown model') || turnMessage.toLowerCase().includes('not found')));

  if (isInvalidModel) {
    return {
      isFallbackCandidate: true,
      category: 'invalid_model',
      reason: `Invalid or unavailable model${status ? ` (HTTP ${status})` : ''}: ${errMsg || turnMessage}`,
      isRetryableSameModel: false,
    };
  }

  // 3. Terminal turn status like "error" or "failed"
  if (turnStatus === 'error' || turnStatus === 'failed') {
    const detail = turnMessage && turnMessage.trim() ? turnMessage.trim() : 'Turn ended with terminal error state';
    const isTurnRateLimit = detail.toLowerCase().includes('rate limit') || detail.toLowerCase().includes('quota');
    return {
      isFallbackCandidate: true,
      category: 'turn_error',
      reason: detail,
      isRetryableSameModel: isTurnRateLimit,
    };
  }

  // 4. HTTP 429 Too Many Requests / 503 / Quota / Rate limit (retryable on same model)
  const isRateLimit =
    status === 429 ||
    status === 503 ||
    errMsg.includes('429') ||
    errMsg.includes('503') ||
    errMsg.toLowerCase().includes('rate limit') ||
    errMsg.toLowerCase().includes('quota') ||
    errMsg.toLowerCase().includes('resource_exhausted') ||
    errMsg.toLowerCase().includes('temporarily unavailable');

  if (isRateLimit) {
    return {
      isFallbackCandidate: true,
      category: 'rate_limit',
      reason: `Rate limit or service overload${status ? ` (HTTP ${status})` : ''}: ${errMsg}`,
      isRetryableSameModel: true,
    };
  }

  // 5. Network connection refused / fetch failed
  const isConnRefused =
    errorObj.code === 'ECONNREFUSED' ||
    errorObj.cause?.code === 'ECONNREFUSED' ||
    errMsg.includes('ECONNREFUSED') ||
    errMsg.toLowerCase().includes('fetch failed') ||
    errMsg.toLowerCase().includes('failed to fetch');

  if (isConnRefused) {
    return {
      isFallbackCandidate: true,
      category: 'network',
      reason: `Network unreachable: ${errMsg}`,
      isRetryableSameModel: false,
    };
  }

  // 6. Timeout
  const isTimeout =
    errName.includes('Timeout') ||
    errMsg.toLowerCase().includes('timed out') ||
    errMsg.toLowerCase().includes('timeout');

  if (isTimeout) {
    return {
      isFallbackCandidate: true,
      category: 'timeout',
      reason: `Request timed out: ${errMsg}`,
      isRetryableSameModel: false,
    };
  }

  // 7. Auth / credentials
  if (
    status === 401 ||
    status === 403 ||
    errMsg.includes('401') ||
    errMsg.includes('403') ||
    errMsg.toLowerCase().includes('unauthorized') ||
    errMsg.toLowerCase().includes('forbidden')
  ) {
    return {
      isFallbackCandidate: true,
      category: 'auth',
      reason: `Authentication error${status ? ` (HTTP ${status})` : ''}: ${errMsg}`,
      isRetryableSameModel: false,
    };
  }

  // 8. HTTP 4xx / 5xx
  if (typeof status === 'number' && status >= 400) {
    return {
      isFallbackCandidate: true,
      category: 'http',
      reason: `Server error (HTTP ${status}): ${errMsg}`,
      isRetryableSameModel: false,
    };
  }

  // 9. Any other unexpected failure
  return {
    isFallbackCandidate: true,
    category: 'unknown',
    reason: errMsg,
    isRetryableSameModel: false,
  };
}

/**
 * Executes a runner across an ordered list of models.
 * Automatically retries transient 429/rate-limit errors on the same model with backoff,
 * falls back immediately on 422 invalid model, and cascades through models on persistent errors.
 * Halts immediately without fallback on user cancellation.
 */
export async function executeWithFallback<T>(
  models: string[],
  runner: (model: string, isFallback: boolean) => Promise<T>,
  options: FallbackOptions = {}
): Promise<T> {
  if (!models || models.length === 0) {
    throw new Error('No models configured. Please configure forgepilot.models.');
  }

  const isCancelled = options.isCancelled || (() => false);
  const log = options.log || (() => {});
  const delays = options.backoffDelaysMs ?? [1500, 3000];
  const sleeper = options.sleeper ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const attemptErrors: Array<{ model: string; classification: ErrorClassification }> = [];

  for (let i = 0; i < models.length; i++) {
    if (isCancelled()) {
      throw new Error('Cancelled by user');
    }

    const currentModel = models[i];
    const isFallback = i > 0;
    let modelSucceeded = false;
    let modelResult: T | undefined = undefined;

    for (let attempt = 0; attempt <= delays.length; attempt++) {
      if (isCancelled()) {
        throw new Error('Cancelled by user');
      }

      try {
        const result = await runner(currentModel, isFallback);

        // Check if runner returned a turn error status wrapped in the result
        const turnResult = (result && typeof result === 'object' ? result : {}) as {
          status?: string;
          errorMessage?: string;
          turnStatus?: string;
        };

        const terminalStatus = turnResult.status || turnResult.turnStatus;
        if (terminalStatus === 'error' || terminalStatus === 'failed') {
          const errorReason = turnResult.errorMessage || 'Turn terminated with error state';
          const classification = classifyError(new Error(errorReason), terminalStatus, errorReason);

          if (classification.isRetryableSameModel && attempt < delays.length && !isCancelled()) {
            const delayMs = delays[attempt];
            log(`[Model Rate-Limited] Model ${currentModel} hit rate limit / quota (${errorReason}). Backing off for ${delayMs}ms before retry ${attempt + 1}...`);
            if (options.onRetry) {
              await options.onRetry(currentModel, attempt + 1, delayMs, errorReason);
            }
            await sleeper(delayMs);
            if (isCancelled()) {
              throw new Error('Cancelled by user');
            }
            continue;
          }

          attemptErrors.push({ model: currentModel, classification });
          log(`[Model Failure] Model ${currentModel} ended with status "${terminalStatus}": ${errorReason}`);
          break; // break retry loop to fall back to next model
        }

        // Successful execution
        modelResult = result;
        modelSucceeded = true;
        break;
      } catch (err: unknown) {
        if (isCancelled()) {
          throw new Error('Cancelled by user');
        }

        const classification = classifyError(err);

        // NEVER fallback or retry on cancellation
        if (!classification.isFallbackCandidate || classification.category === 'cancelled') {
          throw err;
        }

        if (classification.isRetryableSameModel && attempt < delays.length && !isCancelled()) {
          const delayMs = delays[attempt];
          log(`[Model Rate-Limited] Model ${currentModel} hit rate limit (${classification.reason}). Backing off for ${delayMs}ms before retry ${attempt + 1}...`);
          if (options.onRetry) {
            await options.onRetry(currentModel, attempt + 1, delayMs, classification.reason);
          }
          await sleeper(delayMs);
          if (isCancelled()) {
            throw new Error('Cancelled by user');
          }
          continue;
        }

        attemptErrors.push({ model: currentModel, classification });
        log(`[Model Failure] Model ${currentModel} failed (${classification.category}): ${classification.reason}`);
        break; // break retry loop to fall back to next model
      }
    }

    if (modelSucceeded) {
      return modelResult!;
    }

    const hasNextModel = i < models.length - 1;
    if (hasNextModel && !isCancelled()) {
      const nextModel = models[i + 1];
      const lastErr = attemptErrors[attemptErrors.length - 1];
      log(`[Model Fallback] Falling back from ${currentModel} to ${nextModel}...`);
      if (options.onFallback) {
        await options.onFallback(currentModel, nextModel, lastErr?.classification?.reason || 'Unknown error');
      }
      continue;
    }

    const summary = attemptErrors.map((e) => `[${e.model}: ${e.classification.reason}]`).join(', ');
    throw new Error(`All configured models failed: ${summary}`);
  }

  throw new Error('All configured models failed without producing a result.');
}
