// src/agent/toolResolve.ts

export interface ToolCallRefInput {
  id: string;
  sourceEventId: string;
}

export interface ResolvedToolCall {
  name: string;
  argumentsJson: string;
  rawEventJson: string;
}

export type ListEventsFn = (afterEventId?: string) => Promise<{
  events: unknown[];
  nextAfterEventId?: string | null;
}>;

const MAX_PAGES = 20;

/**
 * Resolves a ToolCallRef by paging through listEvents until the source model.message
 * event is found and extracting the matching tool call by ID.
 * Tolerates camelCase and snake_case field names. Pure: no vscode or SDK imports.
 */
export async function resolveToolCall(
  ref: ToolCallRefInput,
  listEvents: ListEventsFn
): Promise<ResolvedToolCall | undefined> {
  const targetCallId = ref.id;
  const targetSourceEventId = ref.sourceEventId || (ref as any).source_event_id;

  if (!targetCallId || !targetSourceEventId) {
    return undefined;
  }

  let currentCursor: string | undefined = undefined;
  let pageCount = 0;

  while (pageCount < MAX_PAGES) {
    pageCount++;
    const res = await listEvents(currentCursor);
    const events = Array.isArray(res?.events) ? res.events : [];

    for (const event of events) {
      if (!event || typeof event !== 'object') {
        continue;
      }
      const evt = event as Record<string, unknown>;
      const eventId = evt.id;
      const eventType = evt.type;

      if (eventId === targetSourceEventId && eventType === 'model.message') {
        const rawToolCalls = Array.isArray(evt.toolCalls)
          ? evt.toolCalls
          : Array.isArray(evt.tool_calls)
            ? evt.tool_calls
            : [];

        for (const tc of rawToolCalls) {
          if (!tc || typeof tc !== 'object') {
            continue;
          }
          const call = tc as Record<string, unknown>;
          if (call.id === targetCallId) {
            const fn = (call.function ?? {}) as Record<string, unknown>;
            const name = typeof fn.name === 'string' ? fn.name : '';
            let argumentsJson = '';
            if (typeof fn.arguments === 'string') {
              argumentsJson = fn.arguments;
            } else if (fn.arguments !== undefined && fn.arguments !== null) {
              argumentsJson = JSON.stringify(fn.arguments);
            }

            let rawEventJson = '';
            try {
              rawEventJson = JSON.stringify(event);
            } catch {
              rawEventJson = String(event);
            }

            return {
              name,
              argumentsJson,
              rawEventJson,
            };
          }
        }

        // The matching sourceEventId model.message was found, but targetCallId was not in its tool calls
        return undefined;
      }
    }

    if (!res?.nextAfterEventId || res.nextAfterEventId === currentCursor) {
      break;
    }
    currentCursor = res.nextAfterEventId;
  }

  return undefined;
}
