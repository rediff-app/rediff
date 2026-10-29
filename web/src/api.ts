import type { CommitLog, FileDiff, FileEntry, Listing } from './types';

export class AuthError extends Error {}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (res.status === 401) throw new AuthError('unauthorized');
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

/** Without a commit: the diff given on the command line. */
export const fetchListing = (commit?: string) =>
  getJSON<Listing>(commit ? `/api/files?commit=${commit}` : '/api/files');

/** The version in the URL lets the browser cache diffs of committed content forever. */
export const fetchDiff = (f: FileEntry, commit?: string) =>
  getJSON<FileDiff>(
    `/api/diff?path=${encodeURIComponent(f.path)}&v=${encodeURIComponent(f.version)}${commit ? `&commit=${commit}` : ''}`,
  );

export const fetchCommits = (limit: number) => getJSON<CommitLog>(`/api/commits?limit=${limit}`);

export function subscribe(onChange: () => void, onLive: (live: boolean) => void): () => void {
  const es = new EventSource('/api/events');
  let connected = false;
  es.onopen = () => {
    onLive(true);
    // Changes made while we were disconnected were never announced.
    if (connected) onChange();
    connected = true;
  };
  es.onerror = () => onLive(false);
  es.addEventListener('change', onChange);
  return () => es.close();
}
