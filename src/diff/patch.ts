// src/diff/patch.ts
import { structuredPatch } from 'diff';

export interface TextEdit {
  oldText: string;
  newText: string;
}

export type EditResult =
  | { ok: true; text: string }
  | { ok: false; error: string; editIndex?: number };

/**
 * Applies exact-text replacements to an original string.
 *
 * Requirements:
 * - Each oldText must occur EXACTLY ONCE in the original text.
 * - 0 matches -> error "edit N: old_text not found".
 * - >1 matches -> error "edit N: old_text matches K places; include more surrounding lines".
 * - Overlapping edits -> error.
 * - Empty oldText -> error.
 * - Edits are applied against original positions (sorted by position, applied from the end).
 * - Normalises \r\n to \n on both original and edit texts before matching.
 */
export function applyEdits(original: string, edits: TextEdit[]): EditResult {
  const normOriginal = original.replace(/\r\n/g, '\n');

  interface EditRange {
    editIndex: number;
    start: number;
    end: number;
    newText: string;
  }

  const ranges: EditRange[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    const oldText = edit.oldText.replace(/\r\n/g, '\n');
    const newText = edit.newText.replace(/\r\n/g, '\n');

    if (!oldText) {
      return { ok: false, error: `edit ${i}: old_text is empty`, editIndex: i };
    }

    let matchCount = 0;
    let matchPos = -1;
    let pos = 0;

    while ((pos = normOriginal.indexOf(oldText, pos)) !== -1) {
      matchCount++;
      matchPos = pos;
      pos += 1;
    }

    if (matchCount === 0) {
      return { ok: false, error: `edit ${i}: old_text not found`, editIndex: i };
    }

    if (matchCount > 1) {
      return {
        ok: false,
        error: `edit ${i}: old_text matches ${matchCount} places; include more surrounding lines`,
        editIndex: i,
      };
    }

    ranges.push({
      editIndex: i,
      start: matchPos,
      end: matchPos + oldText.length,
      newText,
    });
  }

  // Check for overlapping edits
  ranges.sort((a, b) => a.start - b.start);
  for (let j = 1; j < ranges.length; j++) {
    if (ranges[j].start < ranges[j - 1].end) {
      return {
        ok: false,
        error: `overlapping edits at index ${ranges[j - 1].editIndex} and ${ranges[j].editIndex}`,
        editIndex: ranges[j].editIndex,
      };
    }
  }

  // Apply edits in reverse order of position so earlier indices are not shifted
  ranges.sort((a, b) => b.start - a.start);
  let result = normOriginal;
  for (const r of ranges) {
    result = result.slice(0, r.start) + r.newText + result.slice(r.end);
  }

  return { ok: true, text: result };
}

/**
 * Representation of a unified diff hunk.
 *
 * NOTE ON LINE NUMBER SEMANTICS:
 * - id is a stable 0-based index.
 * - oldStart and newStart are 1-based line numbers for standard hunks (oldLines > 0).
 * - EXCEPTION: For hunks with oldLines === 0 (pure insertion), oldStart means
 *   "insert after this original line" (0 = insert at top of file, before line 1).
 *   This matches standard unified diff / patch convention where @@ -k,0 +l,m @@ specifies
 *   insertion after line k.
 */
export interface Hunk {
  id: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
  header: string;
  touchesEnd?: boolean;
  noNewlineAtEndOfFile?: boolean;
}

function splitLines(text: string): { lines: string[]; hasTrailingNewline: boolean } {
  if (text.length === 0) {
    return { lines: [], hasTrailingNewline: false };
  }
  const hasTrailingNewline = text.endsWith('\n');
  const clean = hasTrailingNewline ? text.slice(0, -1) : text;
  return { lines: clean.split('\n'), hasTrailingNewline };
}

/**
 * Computes unified diff hunks between original and proposed text.
 * Works on LF-normalised text.
 */
export function computeHunks(original: string, proposed: string, contextLines = 3): Hunk[] {
  const normOriginal = original.replace(/\r\n/g, '\n');
  const normProposed = proposed.replace(/\r\n/g, '\n');

  if (normOriginal === normProposed) {
    return [];
  }

  const patch = structuredPatch('', '', normOriginal, normProposed, '', '', { context: contextLines });
  const origInfo = splitLines(normOriginal);
  const propInfo = splitLines(normProposed);

  return patch.hunks.map((rawHunk, i) => {
    const isPureInsertion = rawHunk.oldLines === 0;
    // In jsdiff, when oldLines === 0, oldStart is 1-based line before which to insert.
    // In our convention: oldStart means "insert after this original line" (0 = at top).
    // So rawHunk.oldStart = 1 becomes 0 (insert after line 0, i.e. top).
    const oldStart = isPureInsertion ? rawHunk.oldStart - 1 : rawHunk.oldStart;

    const cleanLines = rawHunk.lines
      .filter((l) => l.startsWith(' ') || l.startsWith('-') || l.startsWith('+'))
      .map((l) => l.replace(/[\r\n]+$/, ''));

    // Check if this hunk touches the very end of the original file
    const touchesEnd = isPureInsertion
      ? oldStart === origInfo.lines.length
      : oldStart - 1 + rawHunk.oldLines >= origInfo.lines.length;

    const header = `@@ -${oldStart},${rawHunk.oldLines} +${rawHunk.newStart},${rawHunk.newLines} @@`;

    return {
      id: i,
      oldStart,
      oldLines: rawHunk.oldLines,
      newStart: rawHunk.newStart,
      newLines: rawHunk.newLines,
      lines: cleanLines,
      header,
      touchesEnd,
      noNewlineAtEndOfFile: touchesEnd ? !propInfo.hasTrailingNewline : undefined,
    };
  });
}

/**
 * Applies ONLY the selected hunks to original and returns the new text.
 *
 * Rules:
 * - Process in reverse order of position so earlier line numbers are not shifted.
 * - Unselected hunks leave their original lines untouched.
 * - Never mutates inputs.
 * - Insensitive to which contextLines value was used to compute the hunks.
 */
export function applySelectedHunks(
  original: string,
  hunks: Hunk[],
  selected: ReadonlyArray<number>
): string {
  const normOriginal = original.replace(/\r\n/g, '\n');
  const { lines: origLines, hasTrailingNewline: origHasNl } = splitLines(normOriginal);
  let resultHasTrailingNl = origHasNl;

  const selectedSet = new Set(selected);
  const hunksToApply = hunks
    .filter((h) => selectedSet.has(h.id))
    .map((h) => {
      const insertIndex = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
      return { hunk: h, insertIndex };
    })
    .sort((a, b) => b.insertIndex - a.insertIndex);

  const curLines = [...origLines];

  for (const { hunk, insertIndex } of hunksToApply) {
    // Replacement lines are all lines starting with ' ' (kept context) or '+' (additions),
    // with their 1-character diff prefix stripped.
    const replacement = hunk.lines
      .filter((l) => l.startsWith(' ') || l.startsWith('+'))
      .map((l) => l.slice(1));

    curLines.splice(insertIndex, hunk.oldLines, ...replacement);

    if (hunk.touchesEnd && hunk.noNewlineAtEndOfFile !== undefined) {
      resultHasTrailingNl = !hunk.noNewlineAtEndOfFile;
    }
  }

  if (curLines.length === 0) {
    return '';
  }

  return curLines.join('\n') + (resultHasTrailingNl ? '\n' : '');
}

/**
 * Returns a human-readable one-line summary of a hunk, e.g. "lines 10-14: +3 -1".
 */
export function hunkSummary(h: Hunk): string {
  let added = 0;
  let removed = 0;

  for (const line of h.lines) {
    if (line.startsWith('+')) {
      added++;
    } else if (line.startsWith('-')) {
      removed++;
    }
  }

  if (h.oldLines === 0) {
    const at = h.oldStart === 0 ? 'top' : `line ${h.oldStart}`;
    return `after ${at}: +${added} -${removed}`;
  }

  const end = h.oldStart + h.oldLines - 1;
  const range = h.oldStart === end ? `line ${h.oldStart}` : `lines ${h.oldStart}-${end}`;
  return `${range}: +${added} -${removed}`;
}
