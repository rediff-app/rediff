import { createMemo, createSignal, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import { subscribe } from './api';
import { CommitList } from './Commits';
import { DiffView } from './DiffView';
import { Sidebar } from './Sidebar';
import {
  commits,
  current,
  errorText,
  files,
  live,
  refresh,
  refreshCommits,
  scrollToFile,
  setLive,
  status,
  title,
} from './store';

const COMMITS_KEY = 'rediff.showCommits';

function storedShowCommits(): boolean {
  try {
    return localStorage.getItem(COMMITS_KEY) !== '0';
  } catch {
    return true;
  }
}

export function App() {
  const [showCommits, setShowCommits] = createSignal(storedShowCommits());
  const toggleCommits = () => {
    const show = !showCommits();
    setShowCommits(show);
    try {
      localStorage.setItem(COMMITS_KEY, show ? '1' : '0');
    } catch {
      // Not remembered across reloads; fine.
    }
  };
  // An unborn branch has no commits to pick from.
  const hasCommits = () => commits().length > 0;

  onMount(() => {
    const reload = () => {
      refresh();
      refreshCommits();
    };
    reload();
    onCleanup(subscribe(reload, setLive));
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.target instanceof HTMLInputElement) return;
      if (e.key === 'j') scrollToFile(current() + 1);
      else if (e.key === 'k') scrollToFile(current() - 1);
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  const totals = createMemo(() => files().reduce(([a, d], f) => [a + f.add, d + f.del], [0, 0]));

  return (
    <div class="app">
      <header class="topbar">
        <Show when={hasCommits()}>
          <button
            class="toggle"
            classList={{ on: showCommits() }}
            title={showCommits() ? 'Hide commits' : 'Show commits'}
            onClick={toggleCommits}
          >
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" />
              <path d="M6 3v10" stroke="currentColor" />
            </svg>
          </button>
        </Show>
        <span class="brand">rediff</span>
        <span class="title">{title()}</span>
        <span class="summary">
          {files().length} files <span class="plus">+{totals()[0]}</span> <span class="minus">−{totals()[1]}</span>
        </span>
        <span class="live" classList={{ on: live() }} title={live() ? 'Watching for changes' : 'Disconnected'} />
      </header>
      <Show
        when={status() !== 'unauthorized'}
        fallback={
          <div class="notice">
            This page needs the token from the URL that <code>rediff</code> printed in your terminal. Open that URL
            again.
          </div>
        }
      >
        <div class="main">
          <Show when={showCommits() && hasCommits()}>
            <CommitList />
          </Show>
          <Switch>
            <Match when={status() === 'error'}>
              <div class="notice error">{errorText()}</div>
            </Match>
            <Match when={status() === 'ready' && files().length === 0}>
              <div class="notice">No changes.</div>
            </Match>
            <Match when={status() === 'ready'}>
              <Sidebar />
              <DiffView />
            </Match>
          </Switch>
        </div>
      </Show>
    </div>
  );
}
