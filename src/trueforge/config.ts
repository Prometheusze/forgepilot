// src/trueforge/config.ts

export interface ForgePilotConfig {
  baseUrl: string;
  models: string[];
  mcpPort: number;
  contextBudgetChars: number;
  toolCallPacingMs: number;
}

let activeOverrides: Partial<ForgePilotConfig> | null = null;

export function setForgePilotConfigOverrides(overrides: Partial<ForgePilotConfig> | null): void {
  activeOverrides = overrides;
}

export function getForgePilotConfig(): ForgePilotConfig {
  let baseUrl = activeOverrides?.baseUrl;
  let models = activeOverrides?.models;
  let mcpPort = activeOverrides?.mcpPort;
  let contextBudgetChars = activeOverrides?.contextBudgetChars;
  let toolCallPacingMs = activeOverrides?.toolCallPacingMs;

  try {
    // Dynamically require vscode so pure Node test scripts and live harnesses run seamlessly
    const vscode: any = require('vscode');
    if (vscode && vscode.workspace && typeof vscode.workspace.getConfiguration === 'function') {
      const cfg = vscode.workspace.getConfiguration('forgepilot');
      if (baseUrl === undefined) {
        baseUrl = cfg.get('trueforge.baseUrl', 'http://localhost:8790') as string;
      }
      if (models === undefined) {
        models = cfg.get('models', []) as string[];
      }
      if (mcpPort === undefined) {
        mcpPort = cfg.get('mcp.port', 8791) as number;
      }
      if (contextBudgetChars === undefined) {
        contextBudgetChars = cfg.get('contextBudgetChars', 24000) as number;
      }
      if (toolCallPacingMs === undefined) {
        toolCallPacingMs = cfg.get('toolCallPacingMs', 1500) as number;
      }
    }
  } catch {
    // Pure Node environment
  }

  return {
    baseUrl: baseUrl && baseUrl.trim() ? baseUrl.trim() : 'http://localhost:8790',
    models: Array.isArray(models) ? models.map((m) => m.trim()).filter(Boolean) : [],
    mcpPort: typeof mcpPort === 'number' && mcpPort > 0 ? mcpPort : 8791,
    contextBudgetChars: typeof contextBudgetChars === 'number' && contextBudgetChars > 0 ? contextBudgetChars : 24000,
    toolCallPacingMs: typeof toolCallPacingMs === 'number' && toolCallPacingMs >= 0 ? toolCallPacingMs : 1500,
  };
}
