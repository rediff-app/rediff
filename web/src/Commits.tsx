import { createSelector, For, Show } from 'solid-js';
import { baseTitle, commits, moreCommits, select, selected, showMoreCommits } from './store';
import type { Commit } from './types';

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86400],
  ['month', 30 * 86400],
  ['week', 7 * 86400],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
];

/** "3 days ago" */
function ago(time: number): string {
  const secs = time - Date.now() / 1000;
  for (const [unit, size] of UNITS) if (Math.abs(secs) >= size) return rtf.format(Math.round(secs / size), unit);
  return rtf.format(0, 'second');
}

/** The diff given on the command line, then the current branch's commits, newest first. */
export function CommitList() {
  const isSelected = createSelector(selected);
  return (
    <nav class="commits">
      <div
        class="commit base"
        classList={{ current: selected() === undefined }}
        title={baseTitle()}
        onClick={() => select(undefined)}
      >
        <span class="subject">{baseTitle()}</span>
      </div>
      <For each={commits()}>{(c) => <CommitRow c={c} current={isSelected(c.id)} />}</For>
      <Show when={moreCommits()}>
        <button class="more" onClick={showMoreCommits}>
          Show more
        </button>
      </Show>
    </nav>
  );
}

function CommitRow(p: { c: Commit; current: boolean }) {
  const c = p.c;
  return (
    <div
      class="commit"
      classList={{ current: p.current }}
      title={`${c.id}\n${c.author}, ${new Date(c.time * 1000).toLocaleString()}\n\n${c.subject}`}
      onClick={() => select(c.id)}
    >
      <span class="subject">{c.subject}</span>
      <span class="meta">
        <span class="sha">{c.short}</span> {c.author} · {ago(c.time)}
      </span>
    </div>
  );
}
