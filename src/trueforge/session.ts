// src/trueforge/session.ts
import * as path from 'node:path';
import * as fs from 'node:fs';
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
 * Registers or updates the local MCP server connector with TrueForge via PUT /api/v1/settings/mcp-servers.
 */
export async function registerMcpServer(
  baseUrl: string,
  port: number,
  token: string
): Promise<{ status: number; bodyText: string }> {
  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/settings/mcp-servers`;
  const mcpUrl = `http://127.0.0.1:${port}/mcp/${token}`;
  const requestBody = {
    manifest: {
      type: 'remote',
      name: 'forgepilot-editor',
      url: mcpUrl,
      description: 'ForgePilot VS Code editor MCP server with read-only tools',
    },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err: unknown) {
    throw normalizeTrueForgeError(err, baseUrl);
  }

  const bodyText = await response.text();
  if (response.status !== 200 && response.status !== 201) {
    let extraHint = '';
    if (response.status === 400 && bodyText.includes('Outbound URL blocked')) {
      extraHint =
        '\nHint: restart TrueForge with the environment variable OUTBOUND_URL_ALLOWED_HOSTS=\'["127.0.0.1"]\' (JSON array, exact host match).';
    }
    throw new TrueForgeError(
      `Failed to register MCP server with TrueForge (HTTP ${response.status}): ${bodyText}${extraHint}`,
      response.status
    );
  }

  return { status: response.status, bodyText };
}

/**
 * Creates a basic TrueForge smoke test session configured with the given model name.
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
 * Loads agent/forgepilot.agent.json and creates a TrueForge session with the agent spec
 * configured with modelName and the forgepilot-editor MCP server connector.
 * Supports custom instructions, iterationLimit, and verified context-engineering (compaction).
 */
export async function createAgentSession(
  modelName: string,
  customInstructions?: string,
  customConfig?: any
): Promise<string> {
  const config = getForgePilotConfig();
  const sdk = await loadTrueForgeSdk();

  // Default instructions and config
  let instructions =
    'You are ForgePilot, a coding agent inside VS Code. Be economical: each model step is expensive. Use one targeted search for a specific symbol name, then read only a small line range around it. Do not read whole files. Stop and answer as soon as you have enough. To modify code you MUST call propose_edit (never claim a file was changed unless the tool result says it was applied); read the relevant lines first with read_file and copy old_text exactly; keep edits small; if the user rejects or a hunk does not match, do not repeat the identical proposal. To verify changes or run test suites, use run_terminal_command (which requires user approval). ALL file changes (source code, tests, and documentation) MUST go through propose_edit. NEVER use run_terminal_command to write, overwrite, or delete files. Make minimal, surgical additions via propose_edit and NEVER delete existing tests or unrelated code.';
  let iterationLimit = 16;
  let contextManagement: any = {
    compaction: {
      enabled: true,
    },
    largeToolResponse: {
      enabled: true,
    },
  };

  interface McpServerConfig {
    name: string;
    preloadTools?: string[];
    requireApprovalForTools?: string[];
  }
  let mcpServerConfigs: McpServerConfig[] = [
    {
      name: 'forgepilot-editor',
      preloadTools: ['read_file', 'search_workspace', 'propose_edit', 'run_terminal_command'],
      requireApprovalForTools: ['propose_edit', 'run_terminal_command'],
    },
  ];

  const candidatePaths = [
    path.resolve(process.cwd(), 'agent', 'forgepilot.agent.json'),
    path.resolve(__dirname, '..', '..', 'agent', 'forgepilot.agent.json'),
  ];

  for (const cp of candidatePaths) {
    try {
      if (fs.existsSync(cp)) {
        const raw = fs.readFileSync(cp, 'utf-8');
        const parsed = JSON.parse(raw);
        if (parsed.instructions) {
          instructions = parsed.instructions;
        }
        if (parsed.config?.iteration_limit) {
          iterationLimit = parsed.config.iteration_limit;
        }
        const cm = parsed.config?.context_management || parsed.config?.contextManagement;
        if (cm) {
          contextManagement = {
            compaction: {
              enabled: cm.compaction?.enabled ?? true,
            },
            largeToolResponse: {
              enabled: (cm.large_tool_response?.enabled ?? cm.largeToolResponse?.enabled) ?? true,
            },
          };
        }
        if (Array.isArray(parsed.mcp_servers)) {
          mcpServerConfigs = parsed.mcp_servers.map((s: any) => ({
            name: s.name,
            preloadTools: s.preload_tools || s.preloadTools,
            requireApprovalForTools: s.require_approval_for_tools || s.requireApprovalForTools,
          }));
        }
        break;
      }
    } catch {
      // Continue to next candidate or fallback
    }
  }

  if (customInstructions && customInstructions.trim()) {
    instructions = customInstructions;
  }

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
          instructions,
          mcpServers: mcpServerConfigs,
          config: {
            iterationLimit,
            contextManagement,
            ...(customConfig || {}),
          },
        },
      },
    });

    return response.data.id;
  } catch (err: unknown) {
    throw normalizeTrueForgeError(err, config.baseUrl);
  }
}

/**
 * Creates a turn stream for a session.
 */
export async function createTurnStream(
  sessionId: string,
  prompt: string,
  signal?: AbortSignal
): Promise<any> {
  const config = getForgePilotConfig();
  const sdk = await loadTrueForgeSdk();

  const client = new sdk.TrueForge({
    baseUrl: config.baseUrl,
    timeoutInSeconds: 120,
    maxRetries: 1,
  });

  try {
    return await client.sessions.createTurnStream(
      sessionId,
      {
        input: [
          {
            type: 'user.message',
            content: prompt,
          },
        ],
      },
      signal ? { abortSignal: signal } : undefined
    );
  } catch (err: unknown) {
    throw normalizeTrueForgeError(err, config.baseUrl);
  }
}

/**
 * Posts approval/denial events to a paused turn.
 */
export async function postTurnApprovalEvents(
  sessionId: string,
  turnId: string,
  events: any[]
): Promise<any> {
  const config = getForgePilotConfig();
  const sdk = await loadTrueForgeSdk();

  const client = new sdk.TrueForge({
    baseUrl: config.baseUrl,
    timeoutInSeconds: 30,
    maxRetries: 1,
  });

  try {
    return await client.sessions.createTurnEvents(sessionId, turnId, { events });
  } catch (err: unknown) {
    throw normalizeTrueForgeError(err, config.baseUrl);
  }
}

/**
 * Resumes listening to an existing turn SSE stream from afterEventId.
 */
export async function subscribeTurnStream(
  sessionId: string,
  turnId: string,
  afterEventId?: string,
  signal?: AbortSignal
): Promise<any> {
  const config = getForgePilotConfig();
  const sdk = await loadTrueForgeSdk();

  const client = new sdk.TrueForge({
    baseUrl: config.baseUrl,
    timeoutInSeconds: 120,
    maxRetries: 0,
  });

  try {
    return await client.sessions.subscribeToTurn(
      sessionId,
      turnId,
      afterEventId ? { afterEventId } : undefined,
      signal ? { abortSignal: signal } : undefined
    );
  } catch (err: unknown) {
    throw normalizeTrueForgeError(err, config.baseUrl);
  }
}

/**
 * Fetches the current state of a turn.
 */
export async function getTurn(sessionId: string, turnId: string): Promise<any> {
  const config = getForgePilotConfig();
  const sdk = await loadTrueForgeSdk();

  const client = new sdk.TrueForge({
    baseUrl: config.baseUrl,
    timeoutInSeconds: 30,
    maxRetries: 1,
  });

  try {
    const res = await client.sessions.getTurn(sessionId, turnId);
    return res.data;
  } catch (err: unknown) {
    throw normalizeTrueForgeError(err, config.baseUrl);
  }
}

/**
 * Creates an event lister for a turn that pages through sessions.listTurnEvents.
 */
export async function createTurnEventsLister(
  sessionId: string,
  turnId: string
): Promise<(pageToken?: string) => Promise<{ events: unknown[]; nextAfterEventId?: string | null }>> {
  const config = getForgePilotConfig();
  const sdk = await loadTrueForgeSdk();

  const client = new sdk.TrueForge({
    baseUrl: config.baseUrl,
    timeoutInSeconds: 30,
    maxRetries: 1,
  });

  return async (pageToken?: string) => {
    try {
      const page = await client.sessions.listTurnEvents(sessionId, turnId, {
        pageToken: pageToken || undefined,
        limit: 100,
        order: 'asc',
      });
      const events = Array.isArray(page.data) ? page.data : [];
      const nextToken =
        (page.response as any)?.pagination?.nextPageToken ??
        (page.response as any)?.pagination?.next_page_token ??
        null;
      return {
        events,
        nextAfterEventId: nextToken,
      };
    } catch (err: unknown) {
      throw normalizeTrueForgeError(err, config.baseUrl);
    }
  };
}

export interface StreamTurnResult {
  status: string;
  errorMessage?: string;
}

/**
 * Streams a turn response for the specified session, invoking onDelta for text chunks
 * and optional onEvent for non-delta streaming events.
 * Resolves with the final turn status and any error message from state.message.
 */
export async function streamTurn(
  sessionId: string,
  text: string,
  onDelta: (delta: string) => void,
  signal?: AbortSignal,
  onEvent?: (event: any) => void
): Promise<StreamTurnResult> {
  const config = getForgePilotConfig();
  const sdk = await loadTrueForgeSdk();

  const client = new sdk.TrueForge({
    baseUrl: config.baseUrl,
    timeoutInSeconds: 120,
    maxRetries: 1,
  });

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
  let errorMessage: string | undefined;

  try {
    for await (const event of stream) {
      if (event.type === 'model.message.delta') {
        if (typeof event.content === 'string') {
          onDelta(event.content);
        }
      } else {
        if (onEvent) {
          onEvent(event);
        }
      }

      if (event.type === 'turn.done') {
        finalStatus = event.state.status;
        if (event.state.status === 'error') {
          errorMessage = (event.state as { message?: string }).message || 'Turn ended with error state';
        }
      }
    }
  } catch (err: unknown) {
    throw normalizeTrueForgeError(err, config.baseUrl);
  }

  return { status: finalStatus, errorMessage };
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
