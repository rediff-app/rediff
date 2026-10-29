import { createEffect, createMemo, createSelector, createSignal, For, Show } from 'solid-js';
import { StatusBadge } from './DiffView';
import { Icon } from './Icon';
import { current, filterQuery, isViewed, scrollToFile, setFilterQuery, setUnviewedOnly, unviewedOnly, visibleFiles } from './store';
import { buildTree, type DirNode, type FileNode } from './tree';

type Row = { kind: 'dir'; node: DirNode; depth: number } | { kind: 'file'; node: FileNode; depth: number };

export function Sidebar(p: { onClose: () => void; onNavigate: () => void }) {
  let nav!: HTMLElement;
  const [collapsed, setCollapsed] = createSignal(new Set<string>());
  const toggle = (path: string) => setCollapsed((s) => {
    const next = new Set(s);
    if (!next.delete(path)) next.add(path);
    return next;
  });
  const tree = createMemo(() => buildTree(visibleFiles()));
  const rowCache = createMemo(() => { tree(); return new Map<DirNode | FileNode, Row>(); });
  const rows = createMemo(() => {
    const cache = rowCache();
    const closed = collapsed();
    const out: Row[] = [];
    const walk = (dir: DirNode, depth: number) => {
      for (const node of dir.children) {
        let row = cache.get(node);
        if (!row) { row = node.kind === 'dir' ? { kind: 'dir', node, depth } : { kind: 'file', node, depth }; cache.set(node, row); }
        out.push(row);
        if (node.kind === 'dir' && (filterQuery().trim() || !closed.has(node.path))) walk(node, depth + 1);
      }
    };
    walk(tree(), 0);
    return out;
  });
  const isCurrent = createSelector(current);
  createEffect(() => {
    current(); rows();
    const active = nav.querySelector<HTMLElement>('.current');
    if (!active) return;
    // Scroll only this panel, without moving the surrounding page.
    const y = active.offsetTop;
    if (y < nav.scrollTop) nav.scrollTop = y;
    else if (y + active.offsetHeight > nav.scrollTop + nav.clientHeight) nav.scrollTop = y + active.offsetHeight - nav.clientHeight;
  });

  return (
    <aside class="sidebar">
      <div class="panel-heading"><h2>Changed files</h2><button class="icon-button" aria-label="Hide file tree" onClick={p.onClose}><Icon name="close" size={14} /></button></div>
      <div class="sidebar-filters">
        <div class="search-field"><Icon name="search" /><input id="file-filter" type="search" aria-label="Filter changed files" placeholder="Filter files…" value={filterQuery()} onInput={(e) => setFilterQuery(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Escape') { setFilterQuery(''); e.currentTarget.blur(); } }} /><Show when={filterQuery()} fallback={<kbd>/</kbd>}><button class="clear-search" aria-label="Clear file filter" onClick={() => setFilterQuery('')}><Icon name="close" size={12} /></button></Show></div>
        <label class="filter-checkbox"><input type="checkbox" checked={unviewedOnly()} onChange={(e) => setUnviewedOnly(e.currentTarget.checked)} />Hide viewed files</label>
      </div>
      <nav class="file-tree" ref={nav} aria-label="Changed files">
        <For each={rows()} fallback={<p class="tree-empty">No matching files</p>}>
          {(row) => row.kind === 'dir' ? (
            <button class="entry folder" style={`--depth:${row.depth}`} onClick={() => toggle(row.node.path)} title={row.node.path} aria-expanded={!!filterQuery().trim() || !collapsed().has(row.node.path)}>
              <Icon name="chevron" size={12} class={filterQuery().trim() || !collapsed().has(row.node.path) ? 'chevron open' : 'chevron'} /><Icon name="folder" /><span class="name">{row.node.name}</span>
            </button>
          ) : <FileRow node={row.node} depth={row.depth} current={isCurrent(row.node.index)} onNavigate={p.onNavigate} />}
        </For>
      </nav>
      <div class="sidebar-footer"><span>{visibleFiles().length} files</span><span><kbd>j</kbd> <kbd>k</kbd> to navigate</span></div>
    </aside>
  );
}

function FileRow(p: { node: FileNode; depth: number; current: boolean; onNavigate: () => void }) {
  const f = p.node.file;
  return (
    <button class="entry leaf" classList={{ current: p.current, viewed: isViewed(f) }} style={`--depth:${p.depth}`} data-path={f.path} aria-current={p.current ? 'true' : undefined} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path} onClick={() => { scrollToFile(p.node.index); p.onNavigate(); }}>
      <Icon name={isViewed(f) ? 'check' : 'file'} size={16} /><span class="name">{p.node.name}</span><StatusBadge status={f.status} />
    </button>
  );
}
