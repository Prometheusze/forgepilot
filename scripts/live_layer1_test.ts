// scripts/live_layer1_test.ts
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as cp from 'node:child_process';
import { promisify } from 'node:util';

// Production modules from out/
import { startMcpServer, setWorkspaceRoot, McpServerInstance } from '../out/mcp/server.js';
import {
  registerMcpServer,
  createAgentSession,
  createTurnStream,
  subscribeTurnStream,
  postTurnApprovalEvents,
  createTurnEventsLister,
  cancelSession,
  getTurn,
} from '../out/trueforge/session.js';
import { setForgePilotConfigOverrides } from '../out/trueforge/config.js';
import { assembleContext } from '../out/context/contextAssembler.js';
import { resolveToolCall } from '../out/agent/toolResolve.js';
import { parseProposeEditArgs, canonicalKey, buildProposal } from '../out/review/proposal.js';
import { put as putDecision } from '../out/review/decisions.js';
import { applySelectedHunks } from '../out/diff/patch.js';
import { executeWithFallback, classifyError } from '../out/trueforge/fallbackRunner.js';

const execAsync = promisify(cp.exec);

const FLASK_ROOT = 'C:\\dev\\flask';
const TRUEFORGE_BASE_URL = 'http://localhost:8790';
const MCP_PORT = 8792;
const PRIMARY_MODEL = 'google-gemini/gemini-3-5-flash-lite';
const SECONDARY_MODEL = 'google-gemini/gemini-3-1-flash-lite';

async function runCmd(cmd: string, cwd: string, envOverrides: Record<string, string> = {}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      env: { ...process.env, ...envOverrides },
      shell: 'powershell.exe',
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (err: any) {
    return {
      stdout: (err.stdout || '').trim(),
      stderr: (err.stderr || err.message || '').trim(),
      exitCode: typeof err.code === 'number' ? err.code : 1,
    };
  }
}

/**
 * Executes a live TrueForge turn with full approval loop handling:
 * Resolves tool calls via listTurnEvents, builds/applies proposals via diff engine,
 * records decisions in decisionStore, approves safe terminal commands, and streams to completion.
 */
async function runLiveTurnWithApprovals(
  sessionId: string,
  prompt: string,
  workspaceRoot: string,
  options: {
    onToolCall?: (toolName: string, args: any) => void;
    logEvents?: boolean;
  } = {}
): Promise<{ status: string; errorMessage?: string; editedFiles: Set<string>; toolCalls: string[] }> {
  const editedFiles = new Set<string>();
  const toolCalls: string[] = [];
  const seenToolCallIds = new Set<string>();
  let stream = await createTurnStream(sessionId, prompt);
  let turnDone = false;
  let finalStatus = 'unknown';
  let finalErrorMessage: string | undefined = undefined;
  let currentTurnId: string | null = null;
  let lastSeenEventId: string | undefined = undefined;

  while (!turnDone) {
    let paused = false;
    let pendingApprovals: { id: string; threadId: string; sourceEventId?: string }[] = [];

    for await (const event of stream) {
      if (event.id) {
        lastSeenEventId = event.id;
      }
      if (event.type === 'turn.created') {
        currentTurnId = event.turnId || event.turn_id;
      }
      if (event.type === 'model.message' && Array.isArray(event.toolCalls)) {
        for (const tc of event.toolCalls) {
          const id = tc.id || `${tc.function?.name}-${Date.now()}`;
          if (!seenToolCallIds.has(id)) {
            seenToolCallIds.add(id);
            const fnName = tc.function?.name || tc.name || '';
            let fnArgs: any = {};
            try {
              fnArgs = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : (tc.function?.arguments || {});
            } catch {}
            if (fnName) {
              toolCalls.push(fnName);
              options.onToolCall?.(fnName, fnArgs);
            }
          }
        }
      }
      if (event.type === 'tool.approval_required') {
        const calls = Array.isArray(event.toolCalls) ? event.toolCalls : [];
        pendingApprovals = calls.map((ref: any) => ({
          id: ref.id,
          threadId: event.threadId || event.thread_id || 'main',
          sourceEventId: ref.sourceEventId || ref.source_event_id,
        }));
      }
      if (event.type === 'turn.update' && event.state?.status === 'paused') {
        paused = true;
        break;
      }
      if (event.type === 'turn.done') {
        turnDone = true;
        finalStatus = event.state?.status ?? 'done';
        if (finalStatus === 'error') {
          finalErrorMessage = event.state?.message || 'Turn ended with error';
        }
        break;
      }
    }

    if (turnDone) {
      break;
    }

    if (!paused) {
      if (currentTurnId) {
        const turnInfo = await getTurn(sessionId, currentTurnId);
        finalStatus = turnInfo.state?.status ?? 'done';
        finalErrorMessage = turnInfo.state?.message;
      }
      break;
    }

    if (!currentTurnId) {
      throw new Error('Turn paused without turnId');
    }

    // Resolve approvals
    const lister = await createTurnEventsLister(sessionId, currentTurnId);
    const approvalEvents: any[] = [];

    for (const pending of pendingApprovals) {
      const resolved = await resolveToolCall(
        { id: pending.id, sourceEventId: pending.sourceEventId ?? '' },
        lister
      );

      if (!resolved) {
        console.warn(`[approval] Could not resolve tool call ${pending.id}; denying`);
        approvalEvents.push({
          type: 'user.tool_approval',
          threadId: pending.threadId,
          toolCallId: pending.id,
          approval: { status: 'deny', reason: 'Unresolved tool call' },
        });
        continue;
      }

      const toolName = resolved.name;
      let parsedArgs: any = {};
      try {
        parsedArgs = JSON.parse(resolved.argumentsJson || '{}');
      } catch {
        parsedArgs = {};
      }

      if (!seenToolCallIds.has(pending.id)) {
        seenToolCallIds.add(pending.id);
        toolCalls.push(toolName);
        options.onToolCall?.(toolName, parsedArgs);
      }

      if (toolName.endsWith('propose_edit')) {
        const parseRes = parseProposeEditArgs(parsedArgs);
        if (!parseRes.ok) {
          console.warn(`[approval] Invalid propose_edit args: ${parseRes.error}`);
          approvalEvents.push({
            type: 'user.tool_approval',
            threadId: pending.threadId,
            toolCallId: pending.id,
            approval: { status: 'deny', reason: parseRes.error },
          });
          continue;
        }

        const editArgs = parseRes.args;
        const targetAbs = path.resolve(workspaceRoot, editArgs.path);
        let currentText = '';
        try {
          currentText = fs.readFileSync(targetAbs, 'utf-8');
        } catch {
          // If file does not exist yet, allow new file creation starting from empty text
          currentText = '';
        }

        const prop = buildProposal(currentText, editArgs);
        if (!prop.ok) {
          console.warn(`[approval] buildProposal failed: ${prop.error}`);
          approvalEvents.push({
            type: 'user.tool_approval',
            threadId: pending.threadId,
            toolCallId: pending.id,
            approval: { status: 'deny', reason: prop.error },
          });
          continue;
        }

        const allHunkIds = prop.hunks.map((h: any) => h.id);
        const newText = applySelectedHunks(prop.baseText, prop.hunks, allHunkIds);
        fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
        fs.writeFileSync(targetAbs, newText, 'utf-8');
        editedFiles.add(path.relative(workspaceRoot, targetAbs).replace(/\\/g, '/'));

        putDecision(canonicalKey(editArgs), {
          kind: 'applied',
          path: targetAbs,
          acceptedHunkIds: allHunkIds,
          rejectedHunkIds: [],
          totalHunks: prop.hunks.length,
          saved: true,
        });

        console.log(`[approval] propose_edit applied ${allHunkIds.length} hunk(s) to ${editArgs.path}`);
        approvalEvents.push({
          type: 'user.tool_approval',
          threadId: pending.threadId,
          toolCallId: pending.id,
          approval: { status: 'allow' },
        });
      } else if (toolName.endsWith('run_terminal_command')) {
        console.log(`[approval] run_terminal_command: "${parsedArgs.command}" in ${parsedArgs.cwd || '.'}`);
        approvalEvents.push({
          type: 'user.tool_approval',
          threadId: pending.threadId,
          toolCallId: pending.id,
          approval: { status: 'allow' },
        });
      } else {
        approvalEvents.push({
          type: 'user.tool_approval',
          threadId: pending.threadId,
          toolCallId: pending.id,
          approval: { status: 'allow' },
        });
      }
    }

    await postTurnApprovalEvents(sessionId, currentTurnId, approvalEvents);

    // Brief pacing to respect API rate limits
    await new Promise((r) => setTimeout(r, 2000));

    // Resume stream
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        stream = await subscribeTurnStream(sessionId, currentTurnId, lastSeenEventId);
        break;
      } catch (err) {
        if (attempt === 2) throw err;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  return { status: finalStatus, errorMessage: finalErrorMessage, editedFiles, toolCalls };
}

async function main(): Promise<void> {
  console.log('================================================================');
  console.log('       FORGEPILOT: LAYER 1 REAL INTEGRATION TEST HARNESS        ');
  console.log('================================================================\n');

  // Parse optional --only=A|C|B flag
  const cliArgs = process.argv.slice(2);
  const onlyArg = cliArgs.find((a: string) => a.startsWith('--only='));
  const targetTask = onlyArg ? onlyArg.split('=')[1].toUpperCase() : 'ALL';
  const runTaskA = targetTask === 'ALL' || targetTask === 'A';
  const runTaskC = targetTask === 'ALL' || targetTask === 'C';
  const runTaskB = targetTask === 'ALL' || targetTask === 'B';
  console.log(`Execution filter: target=${targetTask} (A=${runTaskA}, C=${runTaskC}, B=${runTaskB})\n`);

  // Configure environment overrides for pure Node
  setForgePilotConfigOverrides({
    baseUrl: TRUEFORGE_BASE_URL,
    models: [PRIMARY_MODEL, SECONDARY_MODEL],
    mcpPort: MCP_PORT,
  });

  // Verify Flask baseline
  const gitHead = await runCmd('git -C C:\\dev\\flask rev-parse --short=8 HEAD', FLASK_ROOT);
  console.log(`Flask repository commit: ${gitHead.stdout} (expected: 22d92470)`);
  if (gitHead.stdout !== '22d92470') {
    throw new Error(`Unexpected commit: ${gitHead.stdout}`);
  }

  const baselinePytest = await runCmd(
    '& "C:\\dev\\flask\\.venv\\Scripts\\pytest.exe" "C:\\dev\\flask\\tests\\test_cli.py" -q',
    FLASK_ROOT
  );
  console.log(`Baseline pytest tests/test_cli.py: ${baselinePytest.stdout}\n`);
  const baselinePassedMatch = baselinePytest.stdout.match(/(\d+)\s+passed/);
  const baselinePassed = baselinePassedMatch ? parseInt(baselinePassedMatch[1], 10) : 55;

  // Start local MCP server on MCP_PORT (8792) with pacing and register with TrueForge
  console.log(`Starting local MCP server on 127.0.0.1:${MCP_PORT} with 3000ms pacing...`);
  const mcpServer = await startMcpServer(MCP_PORT, { toolCallPacingMs: 3000 });
  setWorkspaceRoot(FLASK_ROOT);
  console.log(`MCP server started at ${mcpServer.redactedUrl}`);

  console.log('Registering MCP server connector with TrueForge...');
  const regResult = await registerMcpServer(TRUEFORGE_BASE_URL, mcpServer.port, mcpServer.token);
  console.log(`TrueForge registration response status: ${regResult.status} OK\n`);

  try {
    // =========================================================================
    // 1. LIVE TEST A: Task A (Inline Edit on Flask 3.1.3)
    // =========================================================================
    if (runTaskA) {
      console.log('----------------------------------------------------------------');
      console.log('>>> RUNNING LIVE TEST A: Task A (Inline Edit on Flask 3.1.3)');
      console.log('----------------------------------------------------------------');

    const helpersPath = path.join(FLASK_ROOT, 'src', 'flask', 'helpers.py');
    const helpersContent = fs.readFileSync(helpersPath, 'utf-8');

    const promptA =
      "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";

    console.log('[Context Assembly] Running assembleContext on Task A prompt...');
    const contextA = await assembleContext({
      workspaceRoot: FLASK_ROOT,
      prompt: promptA,
      activeFilePath: helpersPath,
      activeFileContent: helpersContent,
      budgetChars: 12000,
    });
    console.log(contextA.report);

    // Target region around get_debug_flag lines 28-34
    const helpersLines = helpersContent.split(/\r?\n/);
    const targetRegionLines = helpersLines.slice(27, 34).join('\n');

    const taskAPromptWithContext = [
      'You are performing an INLINE EDIT on file: "src/flask/helpers.py".',
      `User instruction: ${promptA}`,
      '',
      'Target region lines 28-34:',
      '```python',
      targetRegionLines,
      '```',
      '',
      'Rules:',
      '1. Call propose_edit for "src/flask/helpers.py".',
      '2. old_text must match the original text verbatim (without line-number prefixes).',
      '3. Do not modify files directly; only propose_edit is permitted.',
      '4. Once propose_edit is applied, summarize the change and conclude immediately. Do not make additional tool calls.',
      '',
      '<workspace_context>',
      contextA.items.map((it: any) => `--- File: ${it.path}${it.truncated ? ' (truncated)' : ''} ---\n${it.content}`).join('\n\n'),
      '</workspace_context>',
    ].join('\n');

    const inlineInstructions =
      'You are ForgePilot performing an inline code edit. Modify code exclusively by calling propose_edit. Do not make unnecessary tool calls; conclude immediately after propose_edit.';

    console.log(`[TrueForge] Creating agent session with model: ${PRIMARY_MODEL}...`);
    const sessionA = await createAgentSession(PRIMARY_MODEL, inlineInstructions);
    console.log(`[TrueForge] Session ID: ${sessionA}`);

    console.log('[Turn Execution] Streaming turn with approval loop...');
    let resultA = await runLiveTurnWithApprovals(sessionA, taskAPromptWithContext, FLASK_ROOT, {
      onToolCall: (name, args) => console.log(`  [tool_call] ${name}(${JSON.stringify(args).slice(0, 100)}...)`),
    });
    if (resultA.status === 'error') {
      const isRateLimit = resultA.errorMessage?.includes('429') || resultA.errorMessage?.includes('quota');
      const isTimeout = resultA.errorMessage?.includes('Timeout');
      if (isRateLimit || isTimeout) {
        const waitMs = isRateLimit ? 25000 : 2000;
        console.warn(`[Retry] Primary turn encountered transient error (${resultA.errorMessage}). Waiting ${waitMs}ms before retry...`);
        await new Promise((r) => setTimeout(r, waitMs));
        const retrySession = await createAgentSession(PRIMARY_MODEL, inlineInstructions);
        resultA = await runLiveTurnWithApprovals(retrySession, taskAPromptWithContext, FLASK_ROOT, {
          onToolCall: (name, args) => console.log(`  [tool_call] ${name}(${JSON.stringify(args).slice(0, 100)}...)`),
        });
      }
    }
    console.log(`[Turn Result] status: ${resultA.status}`);

    // Verify Python runtime
    console.log('\n[Python Verification]');
    const pyOff = await runCmd(
      '& "C:\\dev\\flask\\.venv\\Scripts\\python.exe" -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"',
      FLASK_ROOT,
      { FLASK_DEBUG: 'off' }
    );
    console.log(`FLASK_DEBUG=off -> ${pyOff.stdout} (expected: False)`);

    const pyN = await runCmd(
      '& "C:\\dev\\flask\\.venv\\Scripts\\python.exe" -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"',
      FLASK_ROOT,
      { FLASK_DEBUG: 'N' }
    );
    console.log(`FLASK_DEBUG=N   -> ${pyN.stdout} (expected: False)`);

    if (pyOff.stdout !== 'False' || pyN.stdout !== 'False') {
      throw new Error(`Task A verification failed: off=${pyOff.stdout}, N=${pyN.stdout}`);
    }

      const diffA = await runCmd('git -C C:\\dev\\flask diff src/flask/helpers.py', FLASK_ROOT);
      console.log('\ngit diff src/flask/helpers.py:\n' + diffA.stdout);

      console.log('\nResetting Flask workspace for Test C...');
      await runCmd('git -C C:\\dev\\flask checkout -- .', FLASK_ROOT);
      console.log('✅ LIVE TEST A PASSED!\n');

      if (runTaskC || runTaskB) {
        console.log('[Cooldown] Pausing 10s to respect rate limits...');
        await new Promise((r) => setTimeout(r, 10000));
      }
    }

    // =========================================================================
    // 2. LIVE TEST C: Task C (Resilience & Automatic Model Fallback)
    // =========================================================================
    if (runTaskC) {
      console.log('----------------------------------------------------------------');
      console.log('>>> RUNNING LIVE TEST C: Task C (Model Fallback & Safety)');
      console.log('----------------------------------------------------------------');

      // Part C1: Automatic fallback from invalid model to working model
      console.log('\n[Part C1: Automatic Fallback]');
      const fallbackModels = ['invalid-provider/unreachable-model', PRIMARY_MODEL];
      let fallbackNotified = false;

      const helpersPath = path.join(FLASK_ROOT, 'src', 'flask', 'helpers.py');
      const helpersContent = fs.readFileSync(helpersPath, 'utf-8');
      const promptA =
        "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.";
      const contextA = await assembleContext({
        workspaceRoot: FLASK_ROOT,
        prompt: promptA,
        activeFilePath: helpersPath,
        activeFileContent: helpersContent,
        budgetChars: 16000,
      });
      const taskAPromptWithContext = [
        promptA,
        '<workspace_context>',
        contextA.items.map((it: any) => `--- File: ${it.path} ---\n${it.content}`).join('\n\n'),
        '</workspace_context>',
      ].join('\n\n');

      let fallbackSessionId = '';
      await executeWithFallback(
      fallbackModels,
      async (modelName: string, isFallback: boolean) => {
        console.log(`Attempting execution with model: ${modelName}${isFallback ? ' (FALLBACK)' : ''}`);
        const sessionId = await createAgentSession(modelName);
        fallbackSessionId = sessionId;
        console.log(`Created session ${sessionId} for model ${modelName}`);

        const res = await runLiveTurnWithApprovals(sessionId, taskAPromptWithContext, FLASK_ROOT);
        if (res.status === 'error') {
          return { status: 'error', errorMessage: res.errorMessage };
        }
        return { status: res.status };
      },
      {
        onFallback: (fromModel: string, toModel: string, reason: string) => {
          fallbackNotified = true;
          console.log(`[Fallback Event] Successfully fell back from ${fromModel} to ${toModel} (reason: ${reason})`);
        },
        log: (msg: string) => console.log(msg),
      }
    );

    if (!fallbackNotified) {
      throw new Error('Part C1 failed: fallback was not triggered');
    }

    const pyFallbackCheck = await runCmd(
      '& "C:\\dev\\flask\\.venv\\Scripts\\python.exe" -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"',
      FLASK_ROOT,
      { FLASK_DEBUG: 'off' }
    );
    console.log(`Fallback run FLASK_DEBUG=off -> ${pyFallbackCheck.stdout} (expected: False)`);
    if (pyFallbackCheck.stdout !== 'False') {
      throw new Error(`Part C1 verification failed: got ${pyFallbackCheck.stdout}`);
    }

    await runCmd('git -C C:\\dev\\flask checkout -- .', FLASK_ROOT);
    console.log('✅ Part C1 (Automatic Fallback) PASSED!');

    // Part C2: Total Failure Safety
    console.log('\n[Part C2: Total Failure Safety]');
    const invalidModels = ['invalid-provider/unreachable-1', 'invalid-provider/unreachable-2'];
    let c2ErrorCaught = false;

    try {
        let fallbackSessionId = '';
      await executeWithFallback(invalidModels, async (modelName: string) => {
        const s = await createAgentSession(modelName);
        return await runLiveTurnWithApprovals(s, 'test', FLASK_ROOT);
      });
    } catch (err: any) {
      c2ErrorCaught = true;
      console.log(`Caught expected clean aggregated error: ${err.message}`);
    }

    if (!c2ErrorCaught) {
      throw new Error('Part C2 failed: did not throw on total failure');
    }

      const gitStatusC2 = await runCmd('git -C C:\\dev\\flask status --short', FLASK_ROOT);
      console.log(`git status --short after total failure: "${gitStatusC2.stdout}" (expected: empty)`);
      if (gitStatusC2.stdout.trim().length > 0) {
        throw new Error(`Workspace was modified during failed run: ${gitStatusC2.stdout}`);
      }
      console.log('✅ Part C2 (Total Failure Safety) PASSED!');
      console.log('✅ LIVE TEST C PASSED!\n');

      if (runTaskB) {
        console.log('[Cooldown] Pausing 10s before Test B to respect rate limits...');
        await new Promise((r) => setTimeout(r, 10000));
      }
    }

    // =========================================================================
    // 3. LIVE TEST B: Task B (Autonomous Multi-file Agent Mode)
    // =========================================================================
    if (runTaskB) {
      console.log('----------------------------------------------------------------');
      console.log('>>> RUNNING LIVE TEST B: Task B (Multi-file Agent Mode)');
      console.log('----------------------------------------------------------------');

    const promptB =
      "Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as '***'. It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.";

    console.log('[Context Assembly] Running assembleContext on Task B prompt (no filenames named)...');
    const contextB = await assembleContext({
      workspaceRoot: FLASK_ROOT,
      prompt: promptB,
      budgetChars: 24000,
    });
    console.log(contextB.report);

    const taskBPromptWithContext = [
      promptB,
      '<workspace_context>',
      contextB.items.map((it: any) => `--- File: ${it.path} ---\n${it.content}`).join('\n\n'),
      '</workspace_context>',
    ].join('\n\n');

    const agentInstructions =
      'You are ForgePilot Agent Mode, an autonomous coding agent operating inside VS Code. ' +
      'Be economical: each model step is expensive. Use targeted search_workspace to locate where built-in CLI commands live, then read only the small relevant line range (under 50 lines). Do not read whole files chunk-by-chunk. ' +
      'Modify code across files exclusively through propose_edit (never claim a file was modified without tool approval). ' +
      'Verify your changes using run_terminal_command. ' +
      'All file edits and terminal commands require human approval before execution. ' +
      'Keep your plan structured, and confirm all steps before concluding.';

    const resultB = await executeWithFallback(
      [PRIMARY_MODEL, SECONDARY_MODEL],
      async (modelName: string, isFallback: boolean) => {
        console.log(`[TrueForge] Creating Agent Mode session with model: ${modelName}${isFallback ? ' (FALLBACK)' : ''}...`);
        const sessionB = await createAgentSession(modelName, agentInstructions, { iterationLimit: 32 });
        console.log(`[TrueForge] Session ID: ${sessionB}`);
        console.log(`[TrueForge] UI Link: ${TRUEFORGE_BASE_URL}`);

        console.log('[Turn Execution] Streaming multi-file Agent Mode turn with approval loop...');
        let res = await runLiveTurnWithApprovals(sessionB, taskBPromptWithContext, FLASK_ROOT, {
          onToolCall: (name, args) => {
            const target = args.path || args.query || args.command || '';
            console.log(`  [tool_call] ${name} -> ${target}`);
          },
        });

        if (res.status === 'error' && (res.errorMessage?.includes('429') || res.errorMessage?.includes('quota'))) {
          console.warn(`[Rate Limit] Hit rate limit on ${modelName} (${res.errorMessage}). Waiting 6s before retry...`);
          await new Promise((r) => setTimeout(r, 6000));
          const retrySession = await createAgentSession(modelName, agentInstructions, { iterationLimit: 32 });
          res = await runLiveTurnWithApprovals(retrySession, taskBPromptWithContext, FLASK_ROOT, {
            onToolCall: (name, args) => {
              const target = args.path || args.query || args.command || '';
              console.log(`  [tool_call] ${name} -> ${target}`);
            },
          });
        }

        if (res.status === 'error') {
          return { status: 'error', errorMessage: res.errorMessage, editedFiles: res.editedFiles, toolCalls: res.toolCalls };
        }
        return res;
      },
      {
        onFallback: (fromModel: string, toModel: string, reason: string) => {
          console.log(`[Automatic Model Fallback] ${fromModel} failed (${reason}). Falling back to ${toModel}...`);
        },
        log: (msg: string) => console.log(msg),
      }
    );

    console.log(`\n[Turn Result] status: ${resultB.status}`);
    console.log(`[Tool Calls] Executed ${resultB.toolCalls.length} tool call(s)`);
    console.log(`[Files Edited] ${Array.from(resultB.editedFiles).join(', ')} (${resultB.editedFiles.size} distinct files)`);

    const diffStatB = await runCmd('git -C C:\\dev\\flask diff --stat', FLASK_ROOT);
    console.log('\ngit diff --stat:\n' + diffStatB.stdout);

    const diffNameOnly = await runCmd('git -C C:\\dev\\flask diff --name-only', FLASK_ROOT);
    const modifiedFiles = diffNameOnly.stdout
      .split('\n')
      .map((s) => s.trim().replace(/\\/g, '/'))
      .filter(Boolean);
    console.log(`Modified files in git: ${modifiedFiles.join(', ')} (${modifiedFiles.length} files)`);

    if (modifiedFiles.length < 3) {
      throw new Error(
        `Task B verification failed: expected >= 3 modified files (implementation, test, docs), got ${modifiedFiles.length}: ${modifiedFiles.join(', ')}`
      );
    }

    for (const file of modifiedFiles) {
      const wasProposed = Array.from(resultB.editedFiles).some(
        (f: string) => f.replace(/\\/g, '/') === file
      );
      if (!wasProposed) {
        throw new Error(
          `Task B verification failed: file "${file}" was modified outside propose_edit (diff-safety bypass detected!)`
        );
      }
    }

    console.log('\n[Verification 1: Pytest on test_cli.py]');
    const pytestB = await runCmd(
      '& "C:\\dev\\flask\\.venv\\Scripts\\pytest.exe" "C:\\dev\\flask\\tests\\test_cli.py" -q',
      FLASK_ROOT
    );
    console.log(`pytest output: ${pytestB.stdout} (exitCode: ${pytestB.exitCode})`);

    const bPassedMatch = pytestB.stdout.match(/(\d+)\s+passed/);
    const bPassed = bPassedMatch ? parseInt(bPassedMatch[1], 10) : 0;
    console.log(`pytest passed count: ${bPassed} (baseline: ${baselinePassed})`);
    if (bPassed < baselinePassed + 1) {
      throw new Error(
        `Task B verification failed: pytest passed count ${bPassed} is less than baseline + 1 (${baselinePassed + 1}); existing tests were lost or broken`
      );
    }

    console.log('\n[Verification 2: flask --help]');
    const flaskHelp = await runCmd(
      '& "C:\\dev\\flask\\.venv\\Scripts\\python.exe" -m flask --help',
      FLASK_ROOT
    );
    const hasConfigInHelp = flaskHelp.stdout.includes('config');
    console.log(`flask --help mentions 'config': ${hasConfigInHelp}`);

    console.log('\n[Verification 3: flask config masked output]');
    // Create minimal test app
    const testAppPath = path.join(FLASK_ROOT, 'test_app_config.py');
    fs.writeFileSync(
      testAppPath,
      [
        'from flask import Flask',
        'app = Flask(__name__)',
        'app.config["SECRET_KEY"] = "super-secret-key"',
        'app.config["DB_PASSWORD"] = "mypassword123"',
        'app.config["API_TOKEN"] = "token_xyz"',
        'app.config["PUBLIC_SETTING"] = "visible_value"',
      ].join('\n')
    );

    const flaskConfigOut = await runCmd(
      '& "C:\\dev\\flask\\.venv\\Scripts\\python.exe" -m flask --app test_app_config config',
      FLASK_ROOT
    );
    console.log(`flask config output:\n${flaskConfigOut.stdout}`);

    // Clean up test app
    try {
      fs.unlinkSync(testAppPath);
    } catch {}

    const hasSecretMasked = flaskConfigOut.stdout.includes('***') && !flaskConfigOut.stdout.includes('super-secret-key');
    const hasPublicVisible = flaskConfigOut.stdout.includes('visible_value');
    console.log(`Secrets masked correctly: ${hasSecretMasked}`);
    console.log(`Public setting visible: ${hasPublicVisible}`);

    if (!hasConfigInHelp) {
      throw new Error("Task B verification failed: 'config' not found in flask --help output");
    }
    if (!hasSecretMasked) {
      throw new Error("Task B verification failed: secrets were not masked with '***' in flask config output");
    }
    if (!hasPublicVisible) {
      throw new Error("Task B verification failed: public setting was not visible in flask config output");
    }

      console.log('\nResetting Flask workspace cleanly for user F5 testing...');
      await runCmd('git -C C:\\dev\\flask checkout -- .', FLASK_ROOT);
      await runCmd('git -C C:\\dev\\flask clean -fd', FLASK_ROOT);
      const finalClean = await runCmd('git -C C:\\dev\\flask status --short', FLASK_ROOT);
      console.log(`Final Flask git status: "${finalClean.stdout}" (clean: ${finalClean.stdout === ''})`);

      console.log('\n================================================================');
      console.log('       ALL LAYER 1 REAL INTEGRATION TESTS PASSED!               ');
      console.log('================================================================');
    }
  } finally {
    console.log('\nDisposing local MCP server...');
    await mcpServer.dispose();
    console.log('MCP server disposed.');
  }
}

void main().catch((err) => {
  console.error('\n❌ LAYER 1 TEST HARNESS FAILED:', err);
  process.exit(1);
});
