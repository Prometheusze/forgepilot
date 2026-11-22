// src/review/decisions.ts

export interface AppliedDecisionOutcome {
  kind: 'applied';
  path: string;
  acceptedHunkIds: number[];
  rejectedHunkIds: number[];
  totalHunks: number;
  saved: boolean;
}

interface StoredEntry {
  outcome: AppliedDecisionOutcome;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 minutes

export class DecisionStore {
  private store = new Map<string, StoredEntry>();

  constructor(private getClock: () => number = () => Date.now()) {}

  /**
   * Puts an approved outcome into the store keyed by canonical proposal key.
   */
  put(key: string, outcome: AppliedDecisionOutcome, now?: number): void {
    const currentTime = now ?? this.getClock();
    this.store.set(key, {
      outcome,
      expiresAt: currentTime + DEFAULT_TTL_MS,
    });
  }

  /**
   * Retrieves and removes an entry from the store (single use).
   * Returns undefined if missing or expired.
   */
  take(key: string, now?: number): AppliedDecisionOutcome | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      return undefined;
    }

    const currentTime = now ?? this.getClock();
    this.store.delete(key);

    if (currentTime > entry.expiresAt) {
      return undefined;
    }

    return entry.outcome;
  }

  /**
   * Clears all stored entries.
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Returns the number of currently stored entries (including uncollected expired ones).
   */
  size(): number {
    return this.store.size;
  }
}

// Global default singleton store used across the extension runtime
const defaultStore = new DecisionStore();

export function put(key: string, outcome: AppliedDecisionOutcome, now?: number): void {
  defaultStore.put(key, outcome, now);
}

export function take(key: string, now?: number): AppliedDecisionOutcome | undefined {
  return defaultStore.take(key, now);
}

export function clear(): void {
  defaultStore.clear();
}
