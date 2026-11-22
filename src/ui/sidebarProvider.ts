// src/ui/sidebarProvider.ts
import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { uiEventBus, ForgePilotUiState } from './eventBus.js';

export class ForgePilotSidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;

  constructor(private readonly _context: vscode.ExtensionContext) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._context.extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Subscribe to state updates from eventBus
    const unsubscribe = uiEventBus.subscribe((state) => {
      this._postStateUpdate(state);
    });

    webviewView.onDidDispose(() => {
      unsubscribe();
      this._view = undefined;
    });

    // Re-hydrate state whenever the sidebar panel becomes visible again
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._postStateUpdate(uiEventBus.getState());
      }
    });

    // Handle messages from the webview client script
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.type) {
        case 'ready': {
          this._postStateUpdate(uiEventBus.getState());
          break;
        }
        case 'runAgent': {
          const prompt = typeof message.prompt === 'string' ? message.prompt.trim() : '';
          await vscode.commands.executeCommand('forgepilot.agentMode', prompt || undefined);
          break;
        }
        case 'runInline': {
          const prompt = typeof message.prompt === 'string' ? message.prompt.trim() : '';
          await vscode.commands.executeCommand('forgepilot.inlineEdit', prompt || undefined);
          break;
        }
        case 'cancelRun': {
          await vscode.commands.executeCommand('forgepilot.cancelRun');
          break;
        }
        case 'undoLastEdit': {
          await vscode.commands.executeCommand('forgepilot.undoLastEdit');
          break;
        }
        case 'openExternal': {
          if (typeof message.url === 'string' && message.url.startsWith('http')) {
            try {
              await vscode.env.openExternal(vscode.Uri.parse(message.url));
            } catch {
              // Ignore invalid url parse
            }
          }
          break;
        }
      }
    });
  }

  private _postStateUpdate(state: ForgePilotUiState): void {
    if (this._view && this._view.visible) {
      this._view.webview.postMessage({
        type: 'stateUpdate',
        state,
      });
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ForgePilot</title>
  <style nonce="${nonce}">
    :root {
      --bg: var(--vscode-sideBar-background, #181818);
      --editor-bg: var(--vscode-editor-background, #1e1e1e);
      --fg: var(--vscode-sideBar-foreground, #cccccc);
      --border: var(--vscode-sideBar-border, #2d2d2d);
      --input-bg: var(--vscode-input-background, #252526);
      --input-fg: var(--vscode-input-foreground, #cccccc);
      --input-border: var(--vscode-input-border, #3c3c3c);
      --btn-bg: var(--vscode-button-background, #0e639c);
      --btn-fg: var(--vscode-button-foreground, #ffffff);
      --btn-hover: var(--vscode-button-hoverBackground, #1177bb);
      --btn-secondary-bg: var(--vscode-button-secondaryBackground, #3a3d41);
      --btn-secondary-fg: var(--vscode-button-secondaryForeground, #ffffff);
      --badge-bg: var(--vscode-badge-background, #4d4d4d);
      --badge-fg: var(--vscode-badge-foreground, #ffffff);
      --accent-green: #4ec9b0;
      --accent-amber: #dcdcaa;
      --accent-red: #f14c4c;
      --accent-blue: #569cd6;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 12px;
      line-height: 1.4;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      overflow-x: hidden;
    }

    /* Header & Status */
    .header-bar {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--border);
    }

    .header-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .brand-title {
      font-weight: 700;
      font-size: 13px;
      letter-spacing: 0.5px;
      color: #ffffff;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      font-weight: 600;
      padding: 2px 7px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #888888;
    }

    .dot.running {
      background: var(--accent-green);
      box-shadow: 0 0 6px var(--accent-green);
      animation: pulse 1.5s infinite;
    }

    .dot.paused_approval {
      background: var(--accent-amber);
      box-shadow: 0 0 6px var(--accent-amber);
    }

    .dot.fallback {
      background: #e5a443;
      box-shadow: 0 0 6px #e5a443;
    }

    .dot.error {
      background: var(--accent-red);
    }

    .dot.cancelled {
      background: #888888;
    }

    .dot.done {
      background: var(--accent-green);
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.4; transform: scale(0.9); }
    }

    .meta-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      flex-wrap: wrap;
    }

    .meta-chip {
      background: var(--input-bg);
      border: 1px solid var(--border);
      padding: 1px 6px;
      border-radius: 4px;
      color: #9cdcfe;
      font-family: monospace;
      font-size: 10px;
    }

    .clickable-link {
      color: var(--accent-blue);
      cursor: pointer;
      text-decoration: underline;
    }

    .clickable-link:hover {
      opacity: 0.8;
    }

    /* Fallback Banner */
    .fallback-banner {
      display: none;
      background: rgba(241, 76, 76, 0.12);
      border: 1px solid rgba(241, 76, 76, 0.4);
      padding: 8px 10px;
      border-radius: 6px;
      font-size: 11px;
      color: #ffb4b4;
    }

    .fallback-banner.active {
      display: block;
    }

    .fallback-title {
      font-weight: 700;
      color: #ff8585;
      margin-bottom: 2px;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    /* Prompt Box */
    .prompt-container {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    textarea#promptInput {
      width: 100%;
      min-height: 65px;
      max-height: 160px;
      resize: vertical;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--input-border);
      border-radius: 4px;
      padding: 6px 8px;
      font-family: inherit;
      font-size: 12px;
      line-height: 1.4;
    }

    textarea#promptInput:focus {
      outline: 1px solid var(--btn-bg);
      border-color: var(--btn-bg);
    }

    .btn-row {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }

    button {
      padding: 5px 10px;
      border-radius: 4px;
      border: none;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.1s ease;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    button.primary {
      background: var(--btn-bg);
      color: var(--btn-fg);
      flex: 1;
      justify-content: center;
    }

    button.primary:hover:not(:disabled) {
      background: var(--btn-hover);
    }

    button.secondary {
      background: var(--btn-secondary-bg);
      color: var(--btn-secondary-fg);
    }

    button.secondary:hover:not(:disabled) {
      opacity: 0.9;
    }

    button.danger {
      background: rgba(241, 76, 76, 0.2);
      border: 1px solid rgba(241, 76, 76, 0.5);
      color: #ff9999;
    }

    button.danger:hover:not(:disabled) {
      background: rgba(241, 76, 76, 0.35);
    }

    button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    /* Cards / Accordions */
    .card {
      background: var(--editor-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
    }

    .card-header {
      padding: 6px 10px;
      background: rgba(255, 255, 255, 0.03);
      border-bottom: 1px solid var(--border);
      font-weight: 600;
      font-size: 11px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
      user-select: none;
    }

    .card-body {
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .card-body.collapsed {
      display: none;
    }

    /* Progress bar */
    .progress-bar-bg {
      width: 100%;
      height: 6px;
      background: rgba(255, 255, 255, 0.08);
      border-radius: 3px;
      overflow: hidden;
    }

    .progress-bar-fill {
      height: 100%;
      background: var(--btn-bg);
      width: 0%;
      transition: width 0.3s ease;
    }

    /* Badges */
    .badge-row {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }

    .eng-badge {
      font-size: 10px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      padding: 1px 5px;
      border-radius: 3px;
      color: #85e89d;
    }

    /* Candidate file list */
    .file-item {
      display: flex;
      flex-direction: column;
      padding: 4px 6px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.05);
      font-size: 11px;
      gap: 2px;
    }

    .file-header-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .file-path {
      font-family: monospace;
      font-size: 11px;
      color: #d4d4d4;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-score {
      font-size: 10px;
      font-weight: 700;
      color: var(--accent-amber);
    }

    .file-reasons {
      font-size: 10px;
      color: #888888;
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }

    .reason-tag {
      background: rgba(255, 255, 255, 0.05);
      padding: 0 4px;
      border-radius: 2px;
    }

    /* Tool calls list */
    .tool-chip {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 4px 6px;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 4px;
      font-size: 11px;
      gap: 6px;
    }

    .tool-info {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow: hidden;
    }

    .tool-name {
      font-family: monospace;
      font-weight: 600;
      color: #4ec9b0;
      white-space: nowrap;
    }

    .tool-target {
      font-family: monospace;
      font-size: 10px;
      color: #888888;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tool-status {
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 10px;
      text-transform: capitalize;
    }

    .tool-status.running { background: rgba(86, 156, 214, 0.2); color: #9cdcfe; }
    .tool-status.awaiting_approval { background: rgba(220, 220, 170, 0.2); color: #dcdcaa; }
    .tool-status.approved { background: rgba(78, 201, 176, 0.2); color: #4ec9b0; }
    .tool-status.denied { background: rgba(241, 76, 76, 0.2); color: #f14c4c; }
    .tool-status.done { background: rgba(255, 255, 255, 0.06); color: #aaaaaa; }

    /* Stream output container */
    .stream-container {
      background: var(--editor-bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      min-height: 120px;
      max-height: 280px;
      overflow-y: auto;
      font-family: var(--vscode-editor-font-family, Consolas, "Courier New", monospace);
      font-size: 11px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
      color: #d4d4d4;
    }

    .empty-hint {
      color: #666666;
      font-style: italic;
      user-select: none;
    }
  </style>
</head>
<body>
  <!-- Header Bar -->
  <div class="header-bar">
    <div class="header-top">
      <div class="brand-title">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2C10.5 4.5 10 6.5 12 8.5C14 6.5 13.5 4.5 12 2Z"/>
          <path d="M3 11L12 7L21 11L17 14L12 11L7 14L3 11Z"/>
        </svg>
        <span>ForgePilot</span>
      </div>
      <div class="status-pill" id="statusPill">
        <div class="dot" id="statusDot"></div>
        <span id="statusText">Idle</span>
      </div>
    </div>
    <div class="meta-row">
      <span class="meta-chip" id="modelChip">Model: none</span>
      <span class="meta-chip clickable-link" id="sessionChip" title="Click to open TrueForge UI in browser">Session: none</span>
    </div>
  </div>

  <!-- Fallback Alert Banner -->
  <div class="fallback-banner" id="fallbackBanner">
    <div class="fallback-title">Model Fallback Active</div>
    <div id="fallbackMessage">Switched model</div>
  </div>

  <!-- Prompt & Action Controls -->
  <div class="prompt-container">
    <textarea id="promptInput" placeholder="Type prompt or task (supports @file and @symbol)...&#10;Press Ctrl+Enter to Run Agent"></textarea>
    <div class="btn-row">
      <button class="primary" id="btnRunAgent" title="Run autonomous agent (Ctrl+Enter)">Run Agent</button>
      <button class="secondary" id="btnInlineEdit" title="Inline edit on active file">Inline</button>
      <button class="danger" id="btnCancel" disabled title="Cancel active run">Stop</button>
      <button class="secondary" id="btnUndo" title="Undo last applied edit">Undo</button>
    </div>
  </div>

  <!-- Context Assembly Card (Collapsible) -->
  <div class="card" id="contextCard">
    <div class="card-header" id="contextCardHeader">
      <span>Context Assembly</span>
      <span id="contextToggleIcon">▼</span>
    </div>
    <div class="card-body" id="contextCardBody">
      <div class="badge-row" id="featureBadges">
        <span class="eng-badge">compaction</span>
        <span class="eng-badge">large_tool_response</span>
        <span class="eng-badge">deferred: get_symbols</span>
      </div>
      <div style="display:flex; justify-content:space-between; font-size:10px; color:#888;">
        <span id="budgetLabel">Budget: 0 / 24,000 (0%)</span>
        <span id="omittedLabel">Omitted: 0</span>
      </div>
      <div class="progress-bar-bg">
        <div class="progress-bar-fill" id="budgetProgress"></div>
      </div>
      <div id="candidateFilesList" style="display:flex; flex-direction:column; gap:4px; margin-top:4px;">
        <span class="empty-hint">No context assembled yet</span>
      </div>
    </div>
  </div>

  <!-- Tool Calls Feed (Collapsible) -->
  <div class="card" id="toolsCard">
    <div class="card-header" id="toolsCardHeader">
      <span>Tool Invocations (<span id="toolCount">0</span>)</span>
      <span id="toolsToggleIcon">▼</span>
    </div>
    <div class="card-body" id="toolsCardBody">
      <div id="toolsList" style="display:flex; flex-direction:column; gap:4px;">
        <span class="empty-hint">No tool calls yet</span>
      </div>
    </div>
  </div>

  <!-- Streaming Output -->
  <div class="stream-container" id="streamOutput"><span class="empty-hint">Live output will stream here...</span></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // Elements
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const modelChip = document.getElementById('modelChip');
    const sessionChip = document.getElementById('sessionChip');
    const fallbackBanner = document.getElementById('fallbackBanner');
    const fallbackMessage = document.getElementById('fallbackMessage');
    const promptInput = document.getElementById('promptInput');
    const btnRunAgent = document.getElementById('btnRunAgent');
    const btnInlineEdit = document.getElementById('btnInlineEdit');
    const btnCancel = document.getElementById('btnCancel');
    const btnUndo = document.getElementById('btnUndo');

    const contextCardHeader = document.getElementById('contextCardHeader');
    const contextCardBody = document.getElementById('contextCardBody');
    const contextToggleIcon = document.getElementById('contextToggleIcon');
    const budgetLabel = document.getElementById('budgetLabel');
    const omittedLabel = document.getElementById('omittedLabel');
    const budgetProgress = document.getElementById('budgetProgress');
    const candidateFilesList = document.getElementById('candidateFilesList');
    const featureBadges = document.getElementById('featureBadges');

    const toolsCardHeader = document.getElementById('toolsCardHeader');
    const toolsCardBody = document.getElementById('toolsCardBody');
    const toolsToggleIcon = document.getElementById('toolsToggleIcon');
    const toolCount = document.getElementById('toolCount');
    const toolsList = document.getElementById('toolsList');

    const streamOutput = document.getElementById('streamOutput');

    let currentTrueforgeUrl = 'http://localhost:8790';

    // Collapsible sections
    contextCardHeader.addEventListener('click', () => {
      const isCollapsed = contextCardBody.classList.toggle('collapsed');
      contextToggleIcon.textContent = isCollapsed ? '▶' : '▼';
    });

    toolsCardHeader.addEventListener('click', () => {
      const isCollapsed = toolsCardBody.classList.toggle('collapsed');
      toolsToggleIcon.textContent = isCollapsed ? '▶' : '▼';
    });

    // Keyboard shortcut in textarea: Ctrl+Enter / Cmd+Enter runs agent
    promptInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        triggerRunAgent();
      }
    });

    // Button actions
    btnRunAgent.addEventListener('click', triggerRunAgent);
    btnInlineEdit.addEventListener('click', () => {
      vscode.postMessage({ type: 'runInline', prompt: promptInput.value });
    });
    btnCancel.addEventListener('click', () => {
      vscode.postMessage({ type: 'cancelRun' });
    });
    btnUndo.addEventListener('click', () => {
      vscode.postMessage({ type: 'undoLastEdit' });
    });

    sessionChip.addEventListener('click', () => {
      vscode.postMessage({ type: 'openExternal', url: currentTrueforgeUrl });
    });

    function triggerRunAgent() {
      const prompt = promptInput.value.trim();
      vscode.postMessage({ type: 'runAgent', prompt });
    }

    // Helper: Safe element creation avoiding innerHTML injection
    function createSafeElement(tag, className, textContent) {
      const el = document.createElement(tag);
      if (className) el.className = className;
      if (textContent !== undefined) el.textContent = textContent;
      return el;
    }

    // Render state snapshot received from extension host
    function renderState(state) {
      if (!state) return;

      currentTrueforgeUrl = state.trueforgeUrl || 'http://localhost:8790';

      // 1. Status Pill & Dot
      statusDot.className = 'dot ' + state.status;
      const statusLabels = {
        idle: 'Idle',
        running: 'Streaming',
        paused_approval: 'Awaiting Approval',
        fallback: 'Fallback Active',
        done: 'Done',
        cancelled: 'Cancelled',
        error: 'Error'
      };
      statusText.textContent = statusLabels[state.status] || state.status;

      // 2. Buttons enabled state
      const isRunning = state.status === 'running' || state.status === 'paused_approval' || state.status === 'fallback';
      btnCancel.disabled = !isRunning;
      btnRunAgent.disabled = isRunning;
      btnInlineEdit.disabled = isRunning;

      // 3. Model & Session chips
      modelChip.textContent = state.activeModel ? ('Model: ' + state.activeModel.split('/').pop()) : 'Model: none';
      sessionChip.textContent = state.sessionId ? ('Session: ' + state.sessionId.slice(0, 10) + '...') : 'Session: none';

      // 4. Fallback Banner
      if (state.fallbackEvents && state.fallbackEvents.length > 0) {
        const lastFallback = state.fallbackEvents[state.fallbackEvents.length - 1];
        fallbackBanner.classList.add('active');
        fallbackMessage.textContent = lastFallback.fromModel.split('/').pop() + ' -> ' + lastFallback.toModel.split('/').pop() + ' (' + lastFallback.reason + ')';
      } else {
        fallbackBanner.classList.remove('active');
      }

      // 5. Context Features Badges
      if (Array.isArray(state.contextEngineering) && state.contextEngineering.length > 0) {
        featureBadges.textContent = '';
        for (const feat of state.contextEngineering) {
          featureBadges.appendChild(createSafeElement('span', 'eng-badge', feat));
        }
      }

      // 6. Context Report
      if (state.contextReport) {
        const r = state.contextReport;
        const pct = r.budgetChars > 0 ? Math.round((r.usedChars / r.budgetChars) * 100) : 0;
        budgetLabel.textContent = 'Budget: ' + r.usedChars.toLocaleString() + ' / ' + r.budgetChars.toLocaleString() + ' (' + pct + '%)';
        omittedLabel.textContent = 'Omitted: ' + r.omittedCount;
        budgetProgress.style.width = Math.min(100, pct) + '%';

        candidateFilesList.textContent = '';
        if (Array.isArray(r.items) && r.items.length > 0) {
          for (const item of r.items) {
            const fileItem = createSafeElement('div', 'file-item');
            const row = createSafeElement('div', 'file-header-row');
            row.appendChild(createSafeElement('span', 'file-path', item.path));
            row.appendChild(createSafeElement('span', 'file-score', '+' + item.score));
            fileItem.appendChild(row);

            if (Array.isArray(item.reasons) && item.reasons.length > 0) {
              const reasonsRow = createSafeElement('div', 'file-reasons');
              for (const reason of item.reasons) {
                reasonsRow.appendChild(createSafeElement('span', 'reason-tag', reason));
              }
              fileItem.appendChild(reasonsRow);
            }
            candidateFilesList.appendChild(fileItem);
          }
        } else {
          candidateFilesList.appendChild(createSafeElement('span', 'empty-hint', 'No candidates scored'));
        }
      }

      // 7. Tool Calls Feed
      if (Array.isArray(state.toolCalls)) {
        toolCount.textContent = String(state.toolCalls.length);
        toolsList.textContent = '';
        if (state.toolCalls.length > 0) {
          for (const tc of state.toolCalls) {
            const chip = createSafeElement('div', 'tool-chip');
            const info = createSafeElement('div', 'tool-info');
            info.appendChild(createSafeElement('span', 'tool-name', tc.name || 'tool'));
            if (tc.target) {
              info.appendChild(createSafeElement('span', 'tool-target', tc.target));
            }
            chip.appendChild(info);
            chip.appendChild(createSafeElement('span', 'tool-status ' + tc.status, tc.status.replace('_', ' ')));
            toolsList.appendChild(chip);
          }
        } else {
          toolsList.appendChild(createSafeElement('span', 'empty-hint', 'No tool calls yet'));
        }
      }

      // 8. Stream output
      if (state.streamText) {
        streamOutput.textContent = state.streamText;
        streamOutput.scrollTop = streamOutput.scrollHeight;
      } else if (state.errorMessage) {
        streamOutput.textContent = 'Error: ' + state.errorMessage;
      } else if (!isRunning) {
        streamOutput.textContent = '';
        streamOutput.appendChild(createSafeElement('span', 'empty-hint', 'Live output will stream here...'));
      }
    }

    // Listen for extension host messages
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg && msg.type === 'stateUpdate') {
        renderState(msg.state);
      }
    });

    // Notify extension host that webview is ready
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
