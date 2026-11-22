// src/mcp/server.ts
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import { registerEditorTools } from './tools.js';

export interface McpServerOptions {
  /**
   * Pacing delay in milliseconds between consecutive JSON-RPC "tools/call" invocations.
   * Defaults to 0 (instant execution in tests).
   */
  toolCallPacingMs?: number;
}

export interface McpServerInstance {
  readonly port: number;
  readonly token: string;
  readonly url: string;
  readonly redactedUrl: string;
  dispose: () => Promise<void>;
}

let activeInstance: McpServerInstance | null = null;
let startPromise: Promise<McpServerInstance> | null = null;
let currentWorkspaceRoot: string | undefined = undefined;

/**
 * Sets or updates the active workspace root used by tool invocations.
 */
export function setWorkspaceRoot(root: string | undefined): void {
  currentWorkspaceRoot = root;
}

/**
 * Returns the currently set workspace root.
 */
export function getActiveWorkspaceRoot(): string | undefined {
  return currentWorkspaceRoot;
}

async function loadMcpModules() {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  return { McpServer, StreamableHTTPServerTransport };
}

/**
 * Starts a local HTTP server exposing MCP at /mcp/<token> bound exclusively to 127.0.0.1.
 * Automatically tries port range [port..port+20] and port 0 (ephemeral) on EADDRINUSE.
 */
export async function startMcpServer(
  port: number,
  options?: McpServerOptions
): Promise<McpServerInstance> {
  const { McpServer, StreamableHTTPServerTransport } = await loadMcpModules();

  const pacingMs = options?.toolCallPacingMs ?? 0;

  // 128-bit random hex string (16 bytes)
  const token = crypto.randomBytes(16).toString('hex');
  const expectedPath = `/mcp/${token}`;

  // Session ID to transport instance mapping
  const sessions = new Map<string, any>();
  let lastToolCallTime = 0;

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host || '127.0.0.1'}`);
      if (parsedUrl.pathname !== expectedPath) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Not found' }, id: null }));
        return;
      }

      let parsedBody: any = undefined;
      if (req.method === 'POST') {
        const bodyChunks: Buffer[] = [];
        for await (const chunk of req) {
          bodyChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }
        const rawBody = Buffer.concat(bodyChunks).toString('utf-8');
        if (rawBody.trim().length > 0) {
          try {
            parsedBody = JSON.parse(rawBody);
          } catch {
            // Not valid JSON
          }
        }

        // Apply request pacing ONLY to JSON-RPC "tools/call" requests (never initialize, notifications, tools/list)
        const isToolCall =
          (parsedBody && parsedBody.method === 'tools/call') ||
          (Array.isArray(parsedBody) && parsedBody.some((item) => item?.method === 'tools/call'));

        if (isToolCall && pacingMs > 0) {
          const now = Date.now();
          const elapsed = now - lastToolCallTime;
          if (elapsed < pacingMs) {
            await new Promise((resolve) => setTimeout(resolve, pacingMs - elapsed));
          }
          lastToolCallTime = Date.now();
        }
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: any;

      if (sessionId && sessions.has(sessionId)) {
        transport = sessions.get(sessionId);
      } else {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid: string) => {
            sessions.set(sid, transport);
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            sessions.delete(sid);
          }
        };

        const mcpServer = new McpServer({
          name: 'forgepilot-editor',
          version: '0.0.1',
        });
        registerEditorTools(mcpServer as any, () => currentWorkspaceRoot);
        await mcpServer.connect(transport);
      }

      await transport.handleRequest(req, res, parsedBody);
    } catch (err: unknown) {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message }, id: null }));
      }
    }
  });

  // Attempt to bind to preferred port, scanning preferredPort..preferredPort+20, then ephemeral port 0
  const candidatePorts: number[] = [];
  if (port > 0) {
    for (let p = port; p <= port + 20; p++) {
      candidatePorts.push(p);
    }
    candidatePorts.push(0);
  } else {
    candidatePorts.push(0);
  }

  let boundPort = port;
  let bound = false;

  for (const candidatePort of candidatePorts) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: any) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(candidatePort, '127.0.0.1');
      });
      const addr = server.address() as net.AddressInfo;
      boundPort = addr.port;
      bound = true;
      break;
    } catch (err: any) {
      if (err && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
        continue;
      }
      throw err;
    }
  }

  if (!bound) {
    throw new Error(`Failed to bind MCP server to 127.0.0.1 on ports ${port}..${port + 20} or 0`);
  }

  const url = `http://127.0.0.1:${boundPort}${expectedPath}`;
  const redactedUrl = `http://127.0.0.1:${boundPort}/mcp/<redacted>`;

  const instance: McpServerInstance = {
    port: boundPort,
    token,
    url,
    redactedUrl,
    dispose: async () => {
      for (const t of sessions.values()) {
        try {
          await t.close();
        } catch {
          // Ignore transport close errors during disposal
        }
      }
      sessions.clear();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      if (activeInstance === instance) {
        activeInstance = null;
        startPromise = null;
        currentWorkspaceRoot = undefined;
      }
    },
  };

  activeInstance = instance;
  return instance;
}

/**
 * Returns the active MCP server instance, or starts one if not already running.
 * Optionally updates the active workspace root.
 */
export async function getOrStartMcpServer(
  port: number,
  workspaceRoot?: string,
  options?: McpServerOptions
): Promise<McpServerInstance> {
  if (workspaceRoot !== undefined) {
    setWorkspaceRoot(workspaceRoot);
  }
  if (activeInstance) {
    return activeInstance;
  }
  if (!startPromise) {
    startPromise = startMcpServer(port, options);
  }
  return await startPromise;
}

/**
 * Disposes the active MCP server instance if running.
 */
export async function disposeMcpServer(): Promise<void> {
  if (activeInstance) {
    await activeInstance.dispose();
  }
}
