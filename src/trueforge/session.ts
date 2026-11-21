// src/trueforge/session.ts
import { loadTrueForgeSdk } from './sdkLoader.js';
import { getForgePilotConfig } from './config.js';

/** Typed error for TrueForge connection, timeout, and API failures */
export class TrueForgeError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = 'TrueForgeError';
  }
}

/**
 * Normalizes SDK, network, and timeout errors into human-readable TrueForgeError instances.
 */
export function normalizeTrueForgeError(err: unknown, baseUrl: string): TrueForgeError {
  if (err instanceof TrueForgeError) {
    return err;
  }

  const baseError = err instanceof Error ? err : new Error(String(err));
  // Inspect potential Node fetch error codes or SDK response status codes without importing internal types
  const errorRecord = (typeof err === 'object' && err !== null ? err : {}) as {
    code?: string;
    statusCode?: number;
    cause?: { code?: string; message?: string };
  };

  const isConnectionRefused =
    errorRecord.code === 'ECONNREFUSED' ||
    errorRecord.cause?.code === 'ECONNREFUSED' ||
    baseError.message.includes('ECONNREFUSED') ||
    baseError.message.includes('fetch failed');

  if (isConnectionRefused) {
    return new TrueForgeError(
      `TrueForge is not reachable at ${baseUrl}. Ensure the server is running (e.g. npx @truefoundry/trueforge).`,
      errorRecord.statusCode,
      err
    );
  }

  const isTimeout =
    baseError.name === 'TrueForgeTimeoutError' ||
    baseError.message.toLowerCase().includes('timeout');

  if (isTimeout) {
    return new TrueForgeError(
      `TrueForge request timed out connecting to ${baseUrl}.`,
      errorRecord.statusCode,
      err
    );
  }

  if (typeof errorRecord.statusCode === 'number') {
    return new TrueForgeError(
      `TrueForge returned HTTP error ${errorRecord.statusCode}: ${baseError.message}`,
      errorRecord.statusCode,
      err
    );
  }

  return new TrueForgeError(baseError.message, undefined, err);
}

/**
 * Creates a new TrueForge session configured with the given model name.
 * Returns the created session identifier.
 */
export async function createSession(modelName: string): Promise<string> {
  const config = getForgePilotConfig();
  const sdk = await loadTrueForgeSdk();

  const client = new sdk.TrueForge({
    baseUrl: config.baseUrl,
    timeoutInSeconds: 30,
    maxRetries: 1,
  });

  try {
    const response = await client.sessions.create({
      agent: {
        spec: {
          model: {
            name: modelName,
          },
          instructions: 'You are ForgePilot, a VS Code coding agent.',
        },
      },
    });

    return response.data.id;
  } catch (err: unknown) {
    throw normalizeTrueForgeError(err, config.baseUrl);
  }
}

/**
 * Streams a turn response for the specified session, invoking onDelta for text chunks.
 * Keeps reading until the stream ends with terminal turn.done and resolves with the final turn status.
 */
export async function streamTurn(
  sessionId: string,
  text: string,
  onDelta: (delta: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const config = getForgePilotConfig();
  const sdk = await loadTrueForgeSdk();

  const client = new sdk.TrueForge({
    baseUrl: config.baseUrl,
    timeoutInSeconds: 120,
    maxRetries: 1,
  });

  // Type inference from createTurnStream returns an AsyncIterable Stream
  type TurnStreamType = Awaited<ReturnType<typeof client.sessions.createTurnStream>>;
  let stream: TurnStreamType;

  try {
    stream = await client.sessions.createTurnStream(
      sessionId,
      {
        input: [
          {
            type: 'user.message',
            content: text,
          },
        ],
      },
      signal ? { abortSignal: signal } : undefined
    );
  } catch (err: unknown) {
    throw normalizeTrueForgeError(err, config.baseUrl);
  }

  let finalStatus = 'done';

  try {
    // Keep reading until the stream ends (including after cancellation)
    for await (const event of stream) {
      if (event.type === 'model.message.delta') {
        if (typeof event.content === 'string') {
          onDelta(event.content);
        }
      } else if (event.type === 'turn.done') {
        finalStatus = event.state.status;
      }
    }
  } catch (err: unknown) {
    throw normalizeTrueForgeError(err, config.baseUrl);
  }

  return finalStatus;
}

/**
 * Cancels the active turn for the given session.
 */
export async function cancelSession(sessionId: string): Promise<void> {
  const config = getForgePilotConfig();
  const sdk = await loadTrueForgeSdk();

  const client = new sdk.TrueForge({
    baseUrl: config.baseUrl,
    timeoutInSeconds: 10,
    maxRetries: 0,
  });

  try {
    await client.sessions.cancel(sessionId);
  } catch (err: unknown) {
    throw normalizeTrueForgeError(err, config.baseUrl);
  }
}
