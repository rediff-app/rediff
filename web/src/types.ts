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

export interface Commit {
  id: string;
  short: string;
  author: string;
  /** author date, seconds since the epoch */
  time: number;
  subject: string;
}

export interface CommitLog {
  /** title of the diff given on the command line */
  base: string;
  commits: Commit[];
  /** there are older commits */
  more: boolean;
}

export type Theme = 'system' | 'light' | 'dark';
export type Layout = 'unified' | 'split';

/** Saved in ~/.rediff/config.yml. */
export interface Settings {
  theme: Theme;
  layout: Layout;
  wrap: boolean;
}

export interface SettingsFile {
  /** absent without a home directory to save in */
  path?: string;
  settings: Settings;
  /** why the saved settings can't be read; `settings` are the defaults then */
  error?: string;
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
