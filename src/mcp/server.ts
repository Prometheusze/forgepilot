// src/mcp/server.ts
import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { registerEditorTools } from './tools.js';

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
 */
export async function startMcpServer(port: number): Promise<McpServerInstance> {
  const { McpServer, StreamableHTTPServerTransport } = await loadMcpModules();

  // 128-bit random hex string (16 bytes)
  const token = crypto.randomBytes(16).toString('hex');
  const expectedPath = `/mcp/${token}`;

  // Session ID to transport instance mapping
  const sessions = new Map<string, any>();

  const server = http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host || '127.0.0.1'}`);
      if (parsedUrl.pathname !== expectedPath) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Not found' }, id: null }));
        return;
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

      await transport.handleRequest(req, res);
    } catch (err: unknown) {
      if (!res.headersSent) {
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message }, id: null }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const url = `http://127.0.0.1:${port}${expectedPath}`;
  const redactedUrl = `http://127.0.0.1:${port}/mcp/<redacted>`;

  const instance: McpServerInstance = {
    port,
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
  workspaceRoot?: string
): Promise<McpServerInstance> {
  if (workspaceRoot !== undefined) {
    setWorkspaceRoot(workspaceRoot);
  }
  if (activeInstance) {
    return activeInstance;
  }
  if (!startPromise) {
    startPromise = startMcpServer(port);
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
