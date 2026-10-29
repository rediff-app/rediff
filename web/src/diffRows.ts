import { ADD, CTX, DEL, type Row } from './types';

/** Source row indices for each side. -1 denotes an empty cell. */
export type SplitPair = [left: number, right: number];

export function splitRows(rows: Row[]): SplitPair[] {
  const result: SplitPair[] = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i][0] !== ADD && rows[i][0] !== DEL) {
      // Context and hunk headers span the same position on both sides.
      result.push([i, i]);
      i++;
      continue;
    }
    const old: number[] = [];
    const next: number[] = [];
    while (i < rows.length && (rows[i][0] === DEL || rows[i][0] === ADD)) {
      (rows[i][0] === DEL ? old : next).push(i++);
    }
    for (let j = 0; j < Math.max(old.length, next.length); j++) {
      result.push([old[j] ?? -1, next[j] ?? -1]);
    }
  }
  return result;
}

/** Include tab stops when estimating a scrollable code column's width. */
export function textColumns(text: string): number {
  if (!/[\t\u0080-\uffff]/.test(text)) return text.length;
  let width = 0;
  for (const char of text) {
    // Wide glyphs are conservative estimates; visible rows are measured in the browser.
    width += char === '\t' ? 4 - width % 4 : char.codePointAt(0)! >= 0x1100 ? 2 : 1;
  }
  return width;
}

export function codeColumns(rows: Row[]): number {
  let max = 0;
  for (const [kind, , , text] of rows) {
    if (kind !== CTX && kind !== ADD && kind !== DEL) continue;
    max = Math.max(max, textColumns(text));
  }
  return max;
}
