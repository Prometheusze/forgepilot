// src/ui/eventBus.ts
import { EventEmitter } from 'node:events';

export type RunMode = 'idle' | 'inline' | 'agent' | 'smoke';
export type RunStatus =
  | 'idle'
  | 'running'
  | 'paused_approval'
  | 'fallback'
  | 'done'
  | 'cancelled'
  | 'error';

export interface ContextItemSummary {
  path: string;
  score: number;
  chars: number;
  truncated: boolean;
  reasons: string[];
}

export interface ContextReportSummary {
  budgetChars: number;
  usedChars: number;
  omittedCount: number;
  items: ContextItemSummary[];
}

export type ToolCallStatus =
  | 'running'
  | 'awaiting_approval'
  | 'approved'
  | 'denied'
  | 'done';

export interface ToolCallItem {
  id: string;
  name: string;
  target: string;
  status: ToolCallStatus;
}

export interface FallbackItem {
  fromModel: string;
  toModel: string;
  reason: string;
  category?: string;
}

export interface ForgePilotUiState {
  generation: number;
  mode: RunMode;
  status: RunStatus;
  prompt: string;
  activeModel: string | null;
  sessionId: string | null;
  trueforgeUrl: string;
  contextEngineering: string[];
  contextReport: ContextReportSummary | null;
  toolCalls: ToolCallItem[];
  fallbackEvents: FallbackItem[];
  streamText: string;
  errorMessage: string | null;
}

export type UiEvent =
  | {
      type: 'runStart';
      generation: number;
      mode: RunMode;
      prompt: string;
      model?: string;
      trueforgeUrl?: string;
      contextEngineering?: string[];
    }
  | {
      type: 'contextAssembled';
      generation: number;
      report: ContextReportSummary;
    }
  | {
      type: 'sessionCreated';
      generation: number;
      sessionId: string;
      model: string;
    }
  | {
      type: 'toolCall';
      generation: number;
      id: string;
      name: string;
      target: string;
      status: ToolCallStatus;
    }
  | {
      type: 'toolApproval';
      generation: number;
      id: string;
      status: 'approved' | 'denied';
    }
  | {
      type: 'modelFallback';
      generation: number;
      fromModel: string;
      toModel: string;
      reason: string;
      category?: string;
    }
  | {
      type: 'streamDelta';
      generation: number;
      delta: string;
    }
  | {
      type: 'statusChange';
      generation: number;
      status: RunStatus;
      errorMessage?: string | null;
    }
  | {
      type: 'runDone';
      generation: number;
      status: 'done' | 'cancelled' | 'error';
      errorMessage?: string | null;
    }
  | {
      type: 'reset';
    };

export const MAX_STREAM_CHARS = 50000;

export function createInitialUiState(): ForgePilotUiState {
  return {
    generation: 0,
    mode: 'idle',
    status: 'idle',
    prompt: '',
    activeModel: null,
    sessionId: null,
    trueforgeUrl: 'http://localhost:8790',
    contextEngineering: ['compaction', 'large_tool_response', 'deferred: get_symbols'],
    contextReport: null,
    toolCalls: [],
    fallbackEvents: [],
    streamText: '',
    errorMessage: null,
  };
}

/**
 * Pure state reducer with generation ID guarding to prevent stale updates
 * from superseded runs from corrupting UI state.
 */
export function reduceUiState(
  state: ForgePilotUiState,
  event: UiEvent
): ForgePilotUiState {
  if (event.type === 'reset') {
    return createInitialUiState();
  }

  // Generation guard: ignore events from an older generation
  if (event.generation < state.generation) {
    return state;
  }

  switch (event.type) {
    case 'runStart': {
      return {
        ...state,
        generation: event.generation,
        mode: event.mode,
        status: 'running',
        prompt: event.prompt,
        activeModel: event.model || state.activeModel,
        sessionId: null,
        trueforgeUrl: event.trueforgeUrl || state.trueforgeUrl,
        contextEngineering:
          event.contextEngineering || [
            'compaction',
            'large_tool_response',
            'deferred: get_symbols',
          ],
        contextReport: null,
        toolCalls: [],
        fallbackEvents: [],
        streamText: '',
        errorMessage: null,
      };
    }

    case 'contextAssembled': {
      return {
        ...state,
        contextReport: event.report,
      };
    }

    case 'sessionCreated': {
      return {
        ...state,
        sessionId: event.sessionId,
        activeModel: event.model,
      };
    }

    case 'toolCall': {
      const existingIdx = state.toolCalls.findIndex((t) => t.id === event.id);
      let updatedToolCalls: ToolCallItem[];
      if (existingIdx >= 0) {
        updatedToolCalls = [...state.toolCalls];
        updatedToolCalls[existingIdx] = {
          ...updatedToolCalls[existingIdx],
          status: event.status,
          target: event.target || updatedToolCalls[existingIdx].target,
        };
      } else {
        updatedToolCalls = [
          ...state.toolCalls,
          {
            id: event.id,
            name: event.name,
            target: event.target,
            status: event.status,
          },
        ];
      }
      return {
        ...state,
        toolCalls: updatedToolCalls,
        status:
          event.status === 'awaiting_approval'
            ? 'paused_approval'
            : state.status === 'paused_approval'
              ? 'running'
              : state.status,
      };
    }

    case 'toolApproval': {
      const updatedToolCalls = state.toolCalls.map((tc) =>
        tc.id === event.id ? { ...tc, status: event.status as ToolCallStatus } : tc
      );
      return {
        ...state,
        toolCalls: updatedToolCalls,
        status: state.status === 'paused_approval' ? 'running' : state.status,
      };
    }

    case 'modelFallback': {
      const fallbackItem: FallbackItem = {
        fromModel: event.fromModel,
        toModel: event.toModel,
        reason: event.reason,
        category: event.category,
      };
      return {
        ...state,
        status: 'fallback',
        activeModel: event.toModel,
        fallbackEvents: [...state.fallbackEvents, fallbackItem],
      };
    }

    case 'streamDelta': {
      let combined = state.streamText + event.delta;
      if (combined.length > MAX_STREAM_CHARS) {
        combined =
          '... [earlier output truncated]\n' +
          combined.slice(combined.length - MAX_STREAM_CHARS);
      }
      return {
        ...state,
        streamText: combined,
        status: state.status === 'fallback' ? 'running' : state.status,
      };
    }

    case 'statusChange': {
      return {
        ...state,
        status: event.status,
        errorMessage: event.errorMessage !== undefined ? event.errorMessage : state.errorMessage,
      };
    }

    case 'runDone': {
      return {
        ...state,
        status: event.status,
        errorMessage: event.errorMessage !== undefined ? event.errorMessage : state.errorMessage,
      };
    }

    default:
      return state;
  }
}

/**
 * Singleton EventBus instance for ForgePilot UI state.
 */
export class UiEventBus {
  private emitter = new EventEmitter();
  private state: ForgePilotUiState = createInitialUiState();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  public getState(): ForgePilotUiState {
    return { ...this.state };
  }

  public emit(event: UiEvent): void {
    this.state = reduceUiState(this.state, event);
    this.emitter.emit('state', this.getState());
  }

  public subscribe(listener: (state: ForgePilotUiState) => void): () => void {
    this.emitter.on('state', listener);
    return () => {
      this.emitter.off('state', listener);
    };
  }

  public reset(): void {
    this.state = createInitialUiState();
    this.emitter.emit('state', this.getState());
  }
}

export const uiEventBus = new UiEventBus();
