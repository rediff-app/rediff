import { createMemo, createSignal, Match, onCleanup, onMount, Show, Switch } from 'solid-js';
import logo from '../../assets/logo.svg';
import { subscribe } from './api';
import { CommitList } from './Commits';
import { DiffView } from './DiffView';
import { Icon } from './Icon';
import { Sidebar } from './Sidebar';
import {
  changeDiffView, collapseAll, commits, current, diffView, errorText, files, filterQuery,
  isCollapsed, live, refresh, refreshCommits, scrollToFile, setFilterQuery, setLive,
  setUnviewedOnly, status, title, toggleCollapsed, toggleViewed, unviewedOnly, viewedCount, visibleFiles,
  toggleWrapLines, wrapLines,
} from './store';

const COMMITS_KEY = 'rediff.showCommits';
function storedShowCommits(): boolean {
  try { return localStorage.getItem(COMMITS_KEY) === '1'; }
  catch { return false; }
}

export function App() {
  const [showCommits, setShowCommits] = createSignal(storedShowCommits());
  const [showFiles, setShowFiles] = createSignal(window.innerWidth > 900);
  const [refreshing, setRefreshing] = createSignal(false);
  let shortcuts!: HTMLDialogElement;
  const toggleCommits = () => {
    const show = !showCommits();
    setShowCommits(show);
    if (show && window.innerWidth <= 900) setShowFiles(false);
    try { localStorage.setItem(COMMITS_KEY, show ? '1' : '0'); } catch { /* Optional preference. */ }
  };
  const toggleFiles = () => {
    setShowFiles((v) => !v);
    if (showFiles() && window.innerWidth <= 900) setShowCommits(false);
  };
  const reload = async () => {
    if (refreshing()) return;
    setRefreshing(true);
    try { await Promise.all([refresh(), refreshCommits()]); }
    finally { setRefreshing(false); }
  };
  const clearFilters = () => { setFilterQuery(''); setUnviewedOnly(false); };

  onMount(() => {
    void reload();
    onCleanup(subscribe(() => { void refresh(); void refreshCommits(); }, setLive));
    const onKey = (e: KeyboardEvent) => {
      const target = e.target;
      if (e.metaKey || e.ctrlKey || e.altKey || shortcuts.open ||
        (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, button')))) return;
      const f = visibleFiles()[current()];
      if (e.key === 'j') scrollToFile(current() + 1);
      else if (e.key === 'k') scrollToFile(current() - 1);
      else if (e.key === 'v' && f) toggleViewed(f);
      else if (e.key === 'c' && f) toggleCollapsed(f);
      else if (e.key === '/') {
        setShowFiles(true);
        if (window.innerWidth <= 900) setShowCommits(false);
        queueMicrotask(() => document.querySelector<HTMLInputElement>('#file-filter')?.focus());
      } else if (e.key === '?') shortcuts.showModal();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    onCleanup(() => window.removeEventListener('keydown', onKey));
  });

  const totals = createMemo(() => files().reduce(([a, d], f) => [a + f.add, d + f.del], [0, 0]));
  const allCollapsed = createMemo(() => visibleFiles().length > 0 && visibleFiles().every(isCollapsed));

  return (
    <div class="app">
      <header class="topbar">
        <span class="brand"><img class="brand-mark" src={logo} alt="" />rediff</span>
        <span class="breadcrumb-separator">/</span>
        <span class="title" title={title()}>{title() || 'Loading comparison…'}</span>
        <div class="topbar-actions">
          <span class="connection" title={live() ? 'Connected to the change stream' : 'Reconnecting to the server'}>
            <span class="live" classList={{ on: live() }} /> <span>{live() ? 'Live' : 'Reconnecting'}</span>
          </span>
          <button class="icon-button" aria-label="Refresh changes" title="Refresh changes" disabled={refreshing()} onClick={reload}>
            <Icon name="refresh" class={refreshing() ? 'spin' : ''} />
          </button>
          <button class="icon-button shortcut-button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => shortcuts.showModal()}><Icon name="keyboard" /></button>
        </div>
      </header>

      <div class="reviewbar">
        <div class="changes-tab"><Icon name="diff" /><h1>Files changed</h1><span class="counter">{files().length}</span></div>
        <div class="summary" aria-label={`${totals()[0]} additions, ${totals()[1]} deletions`}>
          <span class="plus">+{totals()[0].toLocaleString()}</span><span class="minus">−{totals()[1].toLocaleString()}</span>
          <span class="diff-stat" aria-hidden="true"><i style={{ flex: totals()[0] || 0 }} /><i style={{ flex: totals()[1] || 0 }} /></span>
        </div>
        <div class="review-progress" title="Viewed files are tracked for this session and reset when their content changes">
          <progress max={files().length || 1} value={viewedCount()} aria-label="Files viewed" />
          <span>{viewedCount()} / {files().length} viewed</span>
        </div>
      </div>

      <Show when={status() !== 'unauthorized'} fallback={<div class="notice"><img src={logo} alt="" width="40" height="40" /><h2>Open your authenticated link</h2><p>Open the URL printed by <code>rediff</code> in your terminal to view this comparison.</p></div>}>
        <div class="main">
          <section class="workspace" aria-label="Changes">
            <div class="diff-toolbar">
              <Show when={commits().length > 0}>
                <button class="icon-button" classList={{ active: showCommits() }} aria-label="Toggle commit history" aria-pressed={showCommits()} title="Toggle commit history" onClick={toggleCommits}><Icon name="history" /></button>
              </Show>
              <button class="icon-button" classList={{ active: showFiles() }} aria-label="Toggle file tree" aria-pressed={showFiles()} title="Toggle file tree" onClick={toggleFiles}><Icon name="sidebar" /></button>
              <span class="toolbar-label">{visibleFiles().length === files().length ? 'All changes' : `${visibleFiles().length} of ${files().length} files`}</span>
              <div class="toolbar-actions">
                <button class="button wrap-toggle" classList={{ active: wrapLines() }} aria-label="Wrap long lines" aria-pressed={wrapLines()} title="Wrap long lines" onClick={toggleWrapLines}><Icon name="wrap" /><span>Wrap</span></button>
                <div class="segmented" role="group" aria-label="Diff layout">
                  <button aria-pressed={diffView() === 'unified'} classList={{ active: diffView() === 'unified' }} onClick={() => changeDiffView('unified')} title="Unified diff"><Icon name="unified" /><span>Unified</span></button>
                  <button aria-pressed={diffView() === 'split'} classList={{ active: diffView() === 'split' }} onClick={() => changeDiffView('split')} title="Split diff"><Icon name="split" /><span>Split</span></button>
                </div>
                <span class="toolbar-divider" />
                <button class="icon-button" aria-label={allCollapsed() ? 'Expand all files' : 'Collapse all files'} title={allCollapsed() ? 'Expand all files' : 'Collapse all files'} disabled={!visibleFiles().length} onClick={() => collapseAll(!allCollapsed())}><Icon name={allCollapsed() ? 'expand' : 'collapse'} /></button>
                <span class="file-position">{visibleFiles().length ? Math.min(current() + 1, visibleFiles().length) : 0} / {visibleFiles().length}</span>
                <button class="icon-button" aria-label="Previous file" title="Previous file (k)" disabled={current() <= 0 || !visibleFiles().length} onClick={() => scrollToFile(current() - 1)}><Icon name="up" /></button>
                <button class="icon-button" aria-label="Next file" title="Next file (j)" disabled={current() >= visibleFiles().length - 1} onClick={() => scrollToFile(current() + 1)}><Icon name="down" /></button>
              </div>
            </div>
            <div class="workspace-body">
              <Show when={showCommits() && commits().length > 0}><CommitList onClose={() => setShowCommits(false)} /></Show>
              <Show when={showFiles()}><Sidebar onClose={() => setShowFiles(false)} onNavigate={() => { if (window.innerWidth <= 900) setShowFiles(false); }} /></Show>
              <Switch>
                <Match when={status() === 'loading'}><div class="notice" role="status"><span class="loader" /><h2>Loading changes…</h2><p>Preparing your comparison.</p></div></Match>
                <Match when={status() === 'error'}><div class="notice error" role="alert"><h2>Unable to load changes</h2><p>{errorText()}</p><button class="button" onClick={reload}>Try again</button></div></Match>
                <Match when={status() === 'ready' && files().length === 0}><div class="notice"><span class="empty-icon"><Icon name="check" size={28} /></span><h2>No changes to show</h2><p>This comparison is up to date. New changes will appear here automatically.</p></div></Match>
                <Match when={status() === 'ready' && !visibleFiles().length}><div class="notice"><Icon name={unviewedOnly() && !filterQuery() ? 'check' : 'search'} size={32} /><h2>{unviewedOnly() && !filterQuery() ? 'All files viewed' : 'No matching files'}</h2><p>{unviewedOnly() && !filterQuery() ? 'You’ve reviewed every file in this comparison.' : 'Try another file name or clear your filters.'}</p><button class="button" onClick={clearFilters}>Clear filters</button></div></Match>
                <Match when={status() === 'ready'}><DiffView /></Match>
              </Switch>
            </div>
          </section>
        </div>
      </Show>
      <dialog class="shortcuts-dialog" ref={shortcuts} aria-labelledby="shortcuts-title" onClick={(e) => { if (e.target === shortcuts) shortcuts.close(); }}>
        <div class="dialog-content">
          <div class="dialog-heading"><h2 id="shortcuts-title">Keyboard shortcuts</h2><button class="icon-button" aria-label="Close shortcuts" onClick={() => shortcuts.close()}><Icon name="close" /></button></div>
          <dl><dt>Next / previous file</dt><dd><kbd>j</kbd> <kbd>k</kbd></dd><dt>Filter files</dt><dd><kbd>/</kbd></dd><dt>Mark file as viewed</dt><dd><kbd>v</kbd></dd><dt>Collapse / expand file</dt><dd><kbd>c</kbd></dd><dt>Show shortcuts</dt><dd><kbd>?</kbd></dd></dl>
        </div>
      </dialog>
    </div>
  );
}
