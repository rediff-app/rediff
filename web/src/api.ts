import type { FileDiff, FileEntry, Listing } from './types';

export class AuthError extends Error {}

async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (res.status === 401) throw new AuthError('unauthorized');
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json();
}

export const fetchListing = () => getJSON<Listing>('/api/files');

/** The version in the URL lets the browser cache diffs of committed content forever. */
export const fetchDiff = (f: FileEntry) =>
  getJSON<FileDiff>(`/api/diff?path=${encodeURIComponent(f.path)}&v=${encodeURIComponent(f.version)}`);

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
