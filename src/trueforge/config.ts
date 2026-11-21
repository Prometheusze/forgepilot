// src/trueforge/config.ts
import * as vscode from 'vscode';

export interface ForgePilotConfig {
  baseUrl: string;
  models: string[];
}

export function getForgePilotConfig(): ForgePilotConfig {
  const cfg = vscode.workspace.getConfiguration('forgepilot');
  const baseUrl = cfg.get<string>('trueforge.baseUrl', 'http://localhost:8790');
  const models = cfg.get<string[]>('models', []);
  return {
    baseUrl: baseUrl && baseUrl.trim() ? baseUrl.trim() : 'http://localhost:8790',
    models: Array.isArray(models) ? models.map((m) => m.trim()).filter(Boolean) : [],
  };
}
