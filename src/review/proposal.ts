// src/review/proposal.ts
import * as crypto from 'node:crypto';
import { applyEdits, computeHunks, Hunk, TextEdit } from '../diff/patch.js';

export interface ProposeEditArgs {
  path: string;
  edits: { old_text: string; new_text: string }[];
  explanation?: string;
}

const MAX_EDITS = 20;
const MAX_TEXT_LENGTH = 50000;

/**
 * Validates the shape and limits of raw proposal edit arguments.
 * - Must be an object with a non-empty string path.
 * - edits must be an array with 1 to 20 items.
 * - Each edit must have old_text and new_text strings of at most 50,000 characters.
 * - explanation is an optional string.
 */
export function parseProposeEditArgs(
  raw: unknown
): { ok: true; args: ProposeEditArgs } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Arguments must be a non-null object' };
  }

  const rec = raw as Record<string, unknown>;

  if (typeof rec.path !== 'string' || !rec.path.trim()) {
    return { ok: false, error: 'Property "path" must be a non-empty string' };
  }

  if (!Array.isArray(rec.edits)) {
    return { ok: false, error: 'Property "edits" must be an array' };
  }

  if (rec.edits.length === 0) {
    return { ok: false, error: 'Property "edits" cannot be empty' };
  }

  if (rec.edits.length > MAX_EDITS) {
    return {
      ok: false,
      error: `Property "edits" exceeds maximum allowed edits (${MAX_EDITS})`,
    };
  }

  const validatedEdits: { old_text: string; new_text: string }[] = [];

  for (let i = 0; i < rec.edits.length; i++) {
    const edit = rec.edits[i];
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
      return { ok: false, error: `edit ${i}: must be an object` };
    }

    const editRec = edit as Record<string, unknown>;

    if (typeof editRec.old_text !== 'string') {
      return { ok: false, error: `edit ${i}: "old_text" must be a string` };
    }
    if (typeof editRec.new_text !== 'string') {
      return { ok: false, error: `edit ${i}: "new_text" must be a string` };
    }

    if (editRec.old_text.length > MAX_TEXT_LENGTH) {
      return {
        ok: false,
        error: `edit ${i}: "old_text" exceeds maximum length of ${MAX_TEXT_LENGTH} characters`,
      };
    }
    if (editRec.new_text.length > MAX_TEXT_LENGTH) {
      return {
        ok: false,
        error: `edit ${i}: "new_text" exceeds maximum length of ${MAX_TEXT_LENGTH} characters`,
      };
    }

    validatedEdits.push({
      old_text: editRec.old_text,
      new_text: editRec.new_text,
    });
  }

  let explanation: string | undefined;
  if (rec.explanation !== undefined) {
    if (typeof rec.explanation !== 'string') {
      return { ok: false, error: 'Property "explanation" must be a string if provided' };
    }
    explanation = rec.explanation;
  }

  return {
    ok: true,
    args: {
      path: rec.path.trim(),
      edits: validatedEdits,
      ...(explanation !== undefined ? { explanation } : {}),
    },
  };
}

/**
 * Recursively canonicalizes an object by sorting its keys.
 */
function canonicalize(val: unknown): unknown {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalize);
  }
  const keys = Object.keys(val as Record<string, unknown>).sort();
  const sorted: Record<string, unknown> = {};
  for (const k of keys) {
    sorted[k] = canonicalize((val as Record<string, unknown>)[k]);
  }
  return sorted;
}

/**
 * Computes a stable SHA-256 hash over canonical JSON with sorted keys.
 * Identical proposals always produce the exact same key.
 */
export function canonicalKey(args: ProposeEditArgs): string {
  const canonicalObj = canonicalize(args);
  const jsonStr = JSON.stringify(canonicalObj);
  return crypto.createHash('sha256').update(jsonStr, 'utf8').digest('hex');
}

/**
 * Normalises CRLF to LF, applies edits, and computes unified diff hunks.
 * Returns an error if applyEdits fails or if no hunks are produced.
 */
export function buildProposal(
  currentText: string,
  args: ProposeEditArgs
): { ok: true; baseText: string; proposedText: string; hunks: Hunk[] } | { ok: false; error: string } {
  const baseText = currentText.replace(/\r\n/g, '\n');
  const edits: TextEdit[] = args.edits.map((e) => ({
    oldText: e.old_text,
    newText: e.new_text,
  }));

  const res = applyEdits(baseText, edits);
  if (!res.ok) {
    return { ok: false, error: res.error };
  }

  const hunks = computeHunks(baseText, res.text, 3);
  if (hunks.length === 0) {
    return { ok: false, error: 'edits produce no change' };
  }

  return {
    ok: true,
    baseText,
    proposedText: res.text,
    hunks,
  };
}
