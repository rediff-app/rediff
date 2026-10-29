import { createMemo, Match, onCleanup, onMount, Switch } from 'solid-js';
import { subscribe } from './api';
import { DiffView } from './DiffView';
import { Sidebar } from './Sidebar';
import { current, errorText, files, live, refresh, scrollToFile, setLive, status, title } from './store';

export function App() {
  onMount(() => {
    refresh();
    onCleanup(subscribe(refresh, setLive));
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
        <span class="brand">rediff</span>
        <span class="title">{title()}</span>
        <span class="summary">
          {files().length} files <span class="plus">+{totals()[0]}</span> <span class="minus">−{totals()[1]}</span>
        </span>
        <span class="live" classList={{ on: live() }} title={live() ? 'Watching for changes' : 'Disconnected'} />
      </header>
      <Switch>
        <Match when={status() === 'unauthorized'}>
          <div class="notice">
            This page needs the token from the URL that <code>rediff</code> printed in your terminal. Open that URL
            again.
          </div>
        </Match>
        <Match when={status() === 'error'}>
          <div class="notice error">{errorText()}</div>
        </Match>
        <Match when={status() === 'ready' && files().length === 0}>
          <div class="notice">No changes.</div>
        </Match>
        <Match when={status() === 'ready'}>
          <div class="main">
            <Sidebar />
            <DiffView />
          </div>
        </Match>
      </Switch>
    </div>
  );
}

