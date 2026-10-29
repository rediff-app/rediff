import { batch, createSignal, type Accessor, type Setter } from 'solid-js';
import { AuthError, fetchDiff, fetchListing } from './api';
import { highlight, type LineTokens } from './highlight';
import { langFor } from './langs';
import { treeOrder } from './tree';
import { ADD, CTX, DEL, type FileDiff, type FileEntry } from './types';

const MAX_INFLIGHT = 4;
/** Larger diffs are shown without syntax highlighting. */
const MAX_HIGHLIGHT_ROWS = 20_000;
const COLLAPSE_LINES = 3_000;
const GENERATED =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|composer\.lock|Gemfile\.lock)$|\.min\.(js|css)$|\.map$/;

/**
 * A fetched diff. Rows stay plain arrays outside Solid stores, so a
 * 100k-line file costs no proxies; `tick` signals that something changed.
 */
export interface Loaded {
  path: string;
  version: string;
  diff?: FileDiff;
  error?: string;
  /** digits of the largest line number, for the gutter width */
  digits: number;
  /** syntax tokens per row, once the worker is done */
  tokens: Accessor<(LineTokens | undefined)[] | undefined>;
  setTokens: Setter<(LineTokens | undefined)[] | undefined>;
  /** one stable object per row, so <For> keeps the DOM of rows that stay visible */
  items: RowItem[];
}

export interface RowItem {
  l: Loaded;
  i: number;
}

export const [files, setFiles] = createSignal<FileEntry[]>([]);
export const [title, setTitle] = createSignal('');
export const [status, setStatus] = createSignal<'loading' | 'ready' | 'unauthorized' | 'error'>('loading');
export const [errorText, setErrorText] = createSignal('');
export const [live, setLive] = createSignal(false);
export const [current, setCurrent] = createSignal(0);

const loaded = new Map<string, Loaded>();
const collapsedOverride = new Map<string, boolean>();
const [tick, setTick] = createSignal(0);
const bump = () => setTick((t) => t + 1);

export function getLoaded(path: string): Loaded | undefined {
  tick();
  return loaded.get(path);
}

export function itemAt(l: Loaded, i: number): RowItem {
  return (l.items[i] ??= { l, i });
}

export function isCollapsed(f: FileEntry): boolean {
  tick();
  return collapsedOverride.get(f.path) ?? (!!f.large || f.add + f.del > COLLAPSE_LINES || GENERATED.test(f.path));
}

export function toggleCollapsed(f: FileEntry) {
  collapsedOverride.set(f.path, !isCollapsed(f));
  bump();
}

let scrollImpl: (i: number) => void = () => {};
export const setScrollImpl = (fn: (i: number) => void) => (scrollImpl = fn);
export const scrollToFile = (i: number) => scrollImpl(Math.max(0, Math.min(i, files().length - 1)));

let refreshing: Promise<void> | undefined;
let refreshAgain = false;

/** Reloads the file list. Calls during a refresh coalesce into one more refresh. */
export function refresh(): Promise<void> {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      try {
        const listing = await fetchListing();
        const keep = new Set(listing.files.map((f) => f.path));
        for (const path of loaded.keys()) if (!keep.has(path)) loaded.delete(path);
        batch(() => {
          setTitle(listing.title);
          setFiles(treeOrder(listing.files));
          setStatus('ready');
          bump();
        });
      } catch (e) {
        if (e instanceof AuthError) setStatus('unauthorized');
        else batch(() => (setErrorText(String(e)), setStatus('error')));
      }
    } while (refreshAgain);
  })().finally(() => (refreshing = undefined));
  return refreshing;
}

const inflight = new Set<string>();
let wanted: FileEntry[] = [];

/** Fetches these files' diffs (unless current), in order, replacing earlier wishes. */
export function want(fs: FileEntry[]) {
  wanted = fs;
  pump();
}

function pump() {
  while (inflight.size < MAX_INFLIGHT && status() !== 'unauthorized') {
    const f = wanted.find((f) => !inflight.has(f.path) && loaded.get(f.path)?.version !== f.version);
    if (!f) return;
    inflight.add(f.path);
    load(f).finally(() => {
      inflight.delete(f.path);
      pump();
    });
  }
}

async function load(f: FileEntry) {
  let diff: FileDiff | undefined;
  let error: string | undefined;
  try {
    diff = await fetchDiff(f);
  } catch (e) {
    if (e instanceof AuthError) return void setStatus('unauthorized');
    error = String(e);
  }
  let maxLine = 0;
  for (const [, o, n] of diff?.rows ?? []) maxLine = Math.max(maxLine, o, n);
  const [tokens, setTokens] = createSignal<(LineTokens | undefined)[]>();
  const l: Loaded = {
    path: f.path,
    version: f.version,
    diff,
    error,
    digits: Math.max(3, String(maxLine).length),
    tokens,
    setTokens,
    items: [],
  };
  loaded.set(f.path, l);
  bump();
  if (diff) startHighlight(l, diff);
}

function startHighlight(l: Loaded, diff: FileDiff) {
  const lang = langFor(l.path);
  const rows = diff.rows;
  if (!lang || rows.length > MAX_HIGHLIGHT_ROWS) return;

  // Tokenize each side as one text so multi-line constructs keep their state.
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const lineOf = new Int32Array(rows.length).fill(-1);
  rows.forEach(([kind, , , text], i) => {
    if (kind === CTX) {
      lineOf[i] = newLines.length;
      oldLines.push(text);
      newLines.push(text);
    } else if (kind === DEL) {
      lineOf[i] = oldLines.length;
      oldLines.push(text);
    } else if (kind === ADD) {
      lineOf[i] = newLines.length;
      newLines.push(text);
    }
  });

  highlight(lang, oldLines, newLines).then((r) => {
    if (!r || r.old.length !== oldLines.length || r.new.length !== newLines.length) return;
    l.setTokens(rows.map(([kind], i) => (lineOf[i] < 0 ? undefined : (kind === DEL ? r.old : r.new)[lineOf[i]])));
  });
}
