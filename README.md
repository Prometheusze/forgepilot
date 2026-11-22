# ForgePilot 🚀

[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-1.95.0%2B-007ACC.svg?logo=visualstudiocode)](https://code.visualstudio.com/)
[![TrueForge](https://img.shields.io/badge/TrueForge-0.185.1-orange.svg)](https://github.com/truefoundry/trueforge)
[![Tests](https://img.shields.io/badge/Tests-116%2F116%20Passing-brightgreen.svg)](package.json)

**ForgePilot** is a resilient, editor-native autonomous AI coding extension for Visual Studio Code, built on the **TrueForge SDK** (`@truefoundry/trueforge-sdk`) and the **Model Context Protocol (MCP)**.

It pairs deep agentic capabilities with strict diff safety, explainable context assembly, automatic model fallback, and an interactive VS Code Activity Bar sidebar panel.

---

## 🌟 Core Capabilities

### 1. Task A: Inline Edit (`Ctrl+Alt+K`)
- **Single-Turn Localized Editing**: Triggered from the active editor, Command Palette, or Sidebar.
- **Interactive Diff Review**: Proposes edits through MCP `propose_edit` and opens a native side-by-side diff (`vscode.diff`) for review.
- **Per-Hunk Granular Acceptance**: Accept or reject individual hunks before any changes touch the disk.
- **Instant Rollback**: 1-click `Undo Last Edit` (`forgepilot.undoLastEdit`) restores the original file content safely.

### 2. Task B: Autonomous Multi-File Agent Mode
- **Multi-File Problem Solving**: Autonomous multi-turn agent operating through TrueForge session loops.
- **Explainable Context Assembly**: Dynamic workspace scanning prioritizing `@file` references, `@symbol` declarations, and a 1-hop import dependency graph under a strict character budget (default: 24,000 chars).
- **Guarded Terminal Execution**: Sandboxed shell runner (`run_terminal_command`) with human approval and deterministic bypass protection.
- **TrueForge Context Engineering**: Built-in support for turn compaction, large tool response handling, and deferred symbol resolution.

### 3. Task C: Automatic Model Fallback & Zero-Write Resilience
- **Intelligent Error Classification**: Automatically detects and classifies transient network errors (`ECONNREFUSED`), authentication failures (`HTTP 401/403`), invalid models (`HTTP 422`), rate limits / quota walls (`HTTP 429`), timeouts, and terminal turn error payloads.
- **Seamless Cascading Failover**: Transparently retries with exponential backoff on rate limits or cascades across configured models in `forgepilot.models`.
- **Zero Disk Writes on Failure**: Total failure safety guarantees zero unapproved workspace modifications if all models fail or if the user cancels.

### 4. Hard Diff-Safety Guard
- **Deterministic Shell Bypass Prevention**: `run_terminal_command` blocks commands that attempt to write or overwrite files outside `propose_edit` (redirection `> / >>`, PowerShell cmdlets `Set-Content` / `Out-File`, in-place editors `sed -i` / `perl -i` / `tee`, inline script writers `python -c` / `node -e`, and destructive deletion `rm` / `del`).
- **Review Integrity**: All modifications MUST go through `propose_edit` and pass human diff review.

### 5. VS Code Activity Bar Sidebar Panel
- **Real-Time Token Streaming**: Watch model thoughts and code generation unfold in real time.
- **Live Tool Trace**: Chronological log of MCP tool invocations (`read_file`, `search_workspace`, `get_symbols`, `propose_edit`, `run_terminal_command`).
- **Context Assembly Inspector**: Expandable breakdown of context budget usage, file inclusion scores, and reasons.
- **Model Fallback Badges**: Visual indicator displaying active model failover transitions.
- **Quick Action Controls**: 1-click Run Agent, Inline Edit, Cancel Run (Esc), and Undo.

---

## 🏗️ Architecture

```
┌────────────────────────────────────────────────────────┐
│                   VS Code Extension                    │
│                                                        │
│   ┌─────────────────────┐    ┌─────────────────────┐   │
│   │    Sidebar Panel    │    │    Inline Edit      │   │
│   │  (Webview Provider) │    │   (Ctrl+Alt+K)      │   │
│   └──────────┬──────────┘    └──────────┬──────────┘   │
│              │                          │              │
│              ▼                          ▼              │
│   ┌────────────────────────────────────────────────┐   │
│   │          Explainable Context Assembler         │   │
│   │  (@file / @symbol / 1-Hop Graph / Budget)      │   │
│   └──────────────────────┬─────────────────────────┘   │
│                          │                             │
│                          ▼                             │
│   ┌────────────────────────────────────────────────┐   │
│   │         TrueForge Fallback Runner              │   │
│   │   Primary Model ────[Fallback]───► Secondary   │   │
│   └──────────────────────┬─────────────────────────┘   │
│                          │ HTTP / SSE                  │
└──────────────────────────┼─────────────────────────────┘
                           ▼
          ┌──────────────────────────────────┐
          │         TrueForge Server         │
          │      (http://localhost:8790)     │
          └────────────────┬─────────────────┘
                           │ JSON-RPC
                           ▼
          ┌──────────────────────────────────┐
          │      Local Streamable MCP        │
          │    read_file / search_workspace  │
          │     get_symbols / propose_edit   │
          │        run_terminal_command      │
          └──────────────────────────────────┘
```

---

## 🚀 Getting Started

### Prerequisites
- [Visual Studio Code](https://code.visualstudio.com/) v1.95.0 or later
- [Node.js](https://nodejs.org/) v18+ (tested on Node v20/v24)
- A running [TrueForge](https://github.com/truefoundry/trueforge) server (default: `http://localhost:8790`)

### Installation & Build

1. Clone the repository:
   ```bash
   git clone https://github.com/keshavyayy/forgelot.git
   cd forgelot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Compile TypeScript:
   ```bash
   npm run compile
   ```

4. Run the full verification test suite:
   ```bash
   npm run check:all
   ```

### Debugging in VS Code
- Press **F5** in VS Code to launch the Extension Development Host.
- Open any workspace folder (e.g. `C:\dev\flask`).
- Click the **ForgePilot** icon in the Activity Bar or press `Ctrl+Alt+K`.

---

## ⚙️ Configuration

ForgePilot settings can be customized in VS Code (`Preferences -> Settings -> Extensions -> ForgePilot`):

| Setting | Type | Default | Description |
|---|---|---|---|
| `forgepilot.trueforge.baseUrl` | `string` | `http://localhost:8790` | Base URL of the TrueForge server |
| `forgepilot.models` | `string[]` | `["google-gemini/gemini-3-5-flash-lite", "google-gemini/gemini-3-1-flash-lite"]` | Priority-ordered model list for automatic fallback |
| `forgepilot.mcp.port` | `number` | `8791` | Local MCP server port (auto-detects collisions up to 8810) |
| `forgepilot.contextBudgetChars` | `number` | `24000` | Maximum character budget for Explainable Context Assembly |
| `forgepilot.toolCallPacingMs` | `number` | `1500` | Pacing delay between consecutive `tools/call` JSON-RPC requests |

> [!NOTE]
> **Zero Secrets Policy**: Model API keys (such as `GEMINI_API_KEY`) are NEVER stored in `.env` or code. All provider keys are configured securely within the local TrueForge UI (`Settings -> Models`).

---

## ⌨️ Commands & Keybindings

| Command | Keybinding | Category | Description |
|---|---|---|---|
| `forgepilot.inlineEdit` | `Ctrl+Alt+K` (macOS: `Cmd+Alt+K`) | ForgePilot | Trigger Inline Edit on the active editor selection |
| `forgepilot.agentMode` | — | ForgePilot | Launch Autonomous Multi-File Agent Mode |
| `forgepilot.undoLastEdit` | — | ForgePilot | Revert the last applied edit proposal |
| `forgepilot.cancelRun` | `Escape` (when running) | ForgePilot | Cancel the currently active agent run |
| `forgepilot.openPanel` | — | ForgePilot | Focus the ForgePilot Sidebar Panel |
| `forgepilot.smokeTest` | — | ForgePilot | Verify TrueForge connectivity and model availability |

---

## 🧪 Automated Test Suites

ForgePilot includes 8 dedicated, deterministic offline test suites (116 total checks, 0 external dependencies required):

```bash
npm run check:all
```

Individual test runners:
- `npm run check:toolresolve` — Validates tool call ID resolution, pagination, and JSON argument parsing.
- `npm run check:decisions` — Verifies the single-use review decision store, 15-minute TTL, and clock injection.
- `npm run check:review` — Tests proposal construction, argument validation, and diff safety.
- `npm run check:diff` — 35 automated diff/patch tests including Myers algorithm, handwritten hunks, and a 1,000-case deterministic fuzzer.
- `npm run check:mcp` — Validates file size limits, line caps, directory traversal guards, port collision fallback, scoped request pacing, and shell bypass detection.
- `npm run check:context` — Checks `@file` parsing, symbol extraction (Python & TypeScript), 1-hop import graph traversal, and strict character budget enforcement.
- `npm run check:fallback` — Tests automatic failover across 16 scenarios (HTTP 422 fast-fallback, HTTP 429 backoff, network timeouts, cancellation safety).
- `npm run check:ui` — Tests `UiEventBus` state transitions, stream delta capping (50k chars), generation guards, and subscriber events.

---

## 📄 License

This project is licensed under the **ISC License**. See the [LICENSE](LICENSE) file for details.

**Copyright (c) 2026 ForgePilot Contributors: Keshav Jhanwar & Prometheusze**
