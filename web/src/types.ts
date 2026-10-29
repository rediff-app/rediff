export interface FileEntry {
  path: string;
  oldPath?: string;
  /** git status letter, or `?` for untracked files */
  status: string;
  add: number;
  del: number;
  binary: boolean;
  /** too large for the server to count lines */
  large?: boolean;
  /** changes whenever the diff of this file may have changed */
  version: string;
}

export interface Listing {
  title: string;
  files: FileEntry[];
}

export const CTX = 0;
export const ADD = 1;
export const DEL = 2;
export const HUNK = 3;

/**
 * [kind, oldLine, newLine, text, inline?]. Line numbers are 0 when absent;
 * inline holds changed ranges as flat [start, end, ...] UTF-16 offsets.
 */
export type Row = [kind: number, old: number, new: number, text: string, inline?: number[]];

export interface FileDiff {
  binary: boolean;
  rows: Row[];
}
