// src/trueforge/trueforgeClient.ts
/**
 * TrueForge client – communicates with the local TrueForge harness (npx @truefoundry/trueforge).
 * It provides:
 *   • Session creation, turn streaming (SSE) without blocking the extension host.
 *   • Automatic failover to a configured fallback model when the primary model fails.
 *   • Integration with the HunkManager to roll back any staged diffs on failure.
 *   • Minimal public API used by the InlineEditController.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { HunkManager } from '../diff/hunkManager';
import * as yaml from 'js-yaml';

/** Simple event shape emitted by TrueForge SSE stream */
export interface TrueForgeEvent {
  type: string; // e.g. 'token', 'tool_call', 'tool_result', 'error', 'require_approval'
  data: any;
}

/** Configuration aggregated from VS Code settings + trueforge.config.yaml */
interface TrueForgeConfig {
  primaryModel: string;
  fallbackModel: string;
  resilienceMode: 'auto-fallback' | 'manual';
  baseUrl: string; // usually http://localhost:3000
}

/** Helper to read a YAML file if it exists */
function readYamlIfExists(filePath: string): any | null {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return yaml.load(content);
  } catch {
    return null;
  }
}

/**
 * TrueForgeClient – singleton used throughout the extension.
 * It encapsulates all HTTP interactions with the local TrueForge server,
 * handles failover logic, and provides a convenient async generator for streaming.
 */
export class TrueForgeClient {
  // singleton instance
  public static instance = new TrueForgeClient();

  private config: TrueForgeConfig;

  private constructor() {
    // Load configuration from VS Code settings
    const cfg = vscode.workspace.getConfiguration('forgepilot');
    const primary = cfg.get<string>('primaryModel') ?? '';
    const fallback = cfg.get<string>('fallbackModel') ?? '';
    const resilience = cfg.get<string>('resilienceMode') as any ?? 'auto-fallback';

    // Attempt to read trueforge.config.yaml at workspace root (if present)
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let yamlCfg: any = {};
    if (workspaceFolders && workspaceFolders.length > 0) {
      const yamlPath = path.join(workspaceFolders[0].uri.fsPath, 'trueforge.config.yaml');
      yamlCfg = readYamlIfExists(yamlPath) ?? {};
    }

    // Merge – explicit VS Code settings win over YAML defaults
    this.config = {
      primaryModel: primary || yamlCfg.primaryModel || 'default-primary',
      fallbackModel: fallback || yamlCfg.fallbackModel || 'default-fallback',
      resilienceMode: resilience,
      baseUrl: yamlCfg.baseUrl || 'http://localhost:3000',
    };
  }

  /** Refresh configuration – call when user changes settings */
  public reloadConfig() {
    const cfg = vscode.workspace.getConfiguration('forgepilot');
    const primary = cfg.get<string>('primaryModel') ?? '';
    const fallback = cfg.get<string>('fallbackModel') ?? '';
    const resilience = cfg.get<string>('resilienceMode') as any ?? 'auto-fallback';
    const workspaceFolders = vscode.workspace.workspaceFolders;
    let yamlCfg: any = {};
    if (workspaceFolders && workspaceFolders.length > 0) {
      const yamlPath = path.join(workspaceFolders[0].uri.fsPath, 'trueforge.config.yaml');
      yamlCfg = readYamlIfExists(yamlPath) ?? {};
    }
    this.config = {
      primaryModel: primary || yamlCfg.primaryModel || this.config.primaryModel,
      fallbackModel: fallback || yamlCfg.fallbackModel || this.config.fallbackModel,
      resilienceMode: resilience,
      baseUrl: yamlCfg.baseUrl || this.config.baseUrl,
    };
  }

  /** Create a new TrueForge session bound to a specific model */
  public async createSession(model: string): Promise<string> {
    const url = `${this.config.baseUrl}/api/v1/sessions`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`TrueForge session creation failed: ${resp.status} ${txt}`);
    }
    const json = await resp.json();
    return json.id as string;
  }

  /** Approve a tool call (used for propose_edit, run_terminal_command, …) */
  public async approveTool(toolId: string, approved: boolean): Promise<void> {
    const url = `${this.config.baseUrl}/api/v1/tools/${toolId}/approval`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Tool approval failed: ${resp.status} ${txt}`);
    }
  }

  /**
   * Low‑level SSE stream parser – yields TrueForgeEvent objects.
   * The implementation reads the response body as a stream, splits on newlines,
   * and parses any line prefixed with "data:" as JSON.
   */
  private async *sseStream(
    url: string,
    abortSignal?: AbortSignal
  ): AsyncGenerator<TrueForgeEvent, void, unknown> {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'text/event-stream' },
      signal: abortSignal,
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`SSE connection failed: ${resp.status} ${txt}`);
    }
    const reader = (resp.body as any).getReader(); // Node fetch returns a readable stream
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      // keep incomplete line in buffer
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const jsonStr = line.slice(5).trim();
          if (jsonStr) {
            try {
              const data = JSON.parse(jsonStr);
              yield { type: data.type ?? 'unknown', data };
            } catch (e) {
              // malformed JSON – ignore but surface for debugging
              console.warn('Malformed SSE data:', jsonStr);
            }
          }
        } else if (line.startsWith('event:')) {
          // ignore named events for now – we rely on payload.type inside data
        }
      }
    }
  }

  /**
   * Create a turn stream for a given session.
   * `payload` should contain the user instruction and optional context.
   * Returns an async generator of TrueForgeEvent.
   */
  public async *createTurnStream(
    sessionId: string,
    payload: any,
    abortSignal?: AbortSignal
  ): AsyncGenerator<TrueForgeEvent, void, unknown> {
    const url = `${this.config.baseUrl}/api/v1/sessions/${sessionId}/turns?stream=true`;
    // POST the turn payload then listen to the SSE response
    const turnResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
      signal: abortSignal,
    });
    if (!turnResp.ok) {
      const txt = await turnResp.text();
      throw new Error(`Turn request failed: ${turnResp.status} ${txt}`);
    }
    // The body of this response is an event stream
    const streamUrl = `${this.config.baseUrl}/api/v1/sessions/${sessionId}/turns/stream`;
    for await (const ev of this.sseStream(streamUrl, abortSignal)) {
      yield ev;
    }
  }

  /**
   * High‑level orchestrator used by the UI layer.
   * It attempts the turn with the primary model first; on any failure it rolls back
   * staged edits via the supplied `hunkManager`, displays a banner, and retries with
   * the fallback model (if `resilienceMode` is "auto-fallback").
   *
   * Returns an async generator of events from the successful stream.
   */
  public async *runTurnWithFailover(
    payload: any,
    hunkManager: HunkManager,
    abortSignal?: AbortSignal
  ): AsyncGenerator<TrueForgeEvent, void, unknown> {
    const editId = crypto.randomUUID(); // unique identifier for this turn's staged edits
    const tryModel = async (model: string): Promise<boolean> => {
      try {
        const sessionId = await this.createSession(model);
        // Attach editId so our HunkManager can clear it on failure
        const stream = this.createTurnStream(sessionId, payload, abortSignal);
        for await (const ev of stream) {
          // Forward events to the caller (the InlineEditController will forward to UI)
          yield ev;
        }
        return true; // success
      } catch (e: any) {
        // Network / HTTP errors, timeouts, stream parsing errors all land here
        console.warn(`TrueForge turn failed with model ${model}:`, e.message);
        // Cleanup any pending diffs for this edit
        hunkManager.clearEdit(editId);
        // Show a banner to the user – UI thread safe
        vscode.window.showWarningMessage(
          `⚠️ Primary model (${model}) failed (${e.message}). Automatically failing over to backup model (${this.config.fallbackModel})...`
        );
        return false;
      }
    };

    // First attempt with primary
    const primaryOk = await tryModel(this.config.primaryModel);
    if (primaryOk) return; // generator already yielded events

    // If primary failed and resilience is manual, stop here
    if (this.config.resilienceMode !== 'auto-fallback') {
      // No automatic retry – user can manually invoke with fallback model
      return;
    }

    // Attempt fallback model
    await tryModel(this.config.fallbackModel);
    // If fallback also fails we simply exit; the caller will see no events.
  }
}

// Export a ready‑to‑use singleton for convenience
export const trueForgeClient = TrueForgeClient.instance;
