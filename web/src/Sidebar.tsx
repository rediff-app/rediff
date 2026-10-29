import { createEffect, createMemo, createSelector, createSignal, For, Show } from 'solid-js';
import { StatusBadge } from './DiffView';
import { current, files, scrollToFile } from './store';
import { buildTree, type DirNode, type FileNode } from './tree';

type Row = { kind: 'dir'; node: DirNode; depth: number } | { kind: 'file'; node: FileNode; depth: number };

export function Sidebar() {
  let nav!: HTMLElement;
  const [collapsed, setCollapsed] = createSignal(new Set<string>());
  const toggle = (path: string) =>
    setCollapsed((s) => {
      const next = new Set(s);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const tree = createMemo(() => buildTree(files()));
  // One row object per node for the lifetime of a tree, so toggling a
  // directory only creates or removes the DOM of the rows that change.
  const rowCache = createMemo(() => {
    tree();
    return new Map<DirNode | FileNode, Row>();
  });
  const rows = createMemo(() => {
    const cache = rowCache();
    const closed = collapsed();
    const out: Row[] = [];
    const walk = (dir: DirNode, depth: number) => {
      for (const node of dir.children) {
        let row = cache.get(node);
        if (!row) {
          row = node.kind === 'dir' ? { kind: 'dir', node, depth } : { kind: 'file', node, depth };
          cache.set(node, row);
        }
        out.push(row);
        if (node.kind === 'dir' && !closed.has(node.path)) walk(node, depth + 1);
      }
    };
    walk(tree(), 0);
    return out;
  });

  // O(1) update per scroll instead of touching every entry.
  const isCurrent = createSelector(current);
  createEffect(() => {
    current();
    nav.querySelector('.current')?.scrollIntoView({ block: 'nearest' });
  });

  return (
    <nav class="sidebar" ref={nav}>
      <For each={rows()}>
        {(row) =>
          row.kind === 'dir' ? (
            <div class="entry folder" style={`--depth:${row.depth}`} onClick={() => toggle(row.node.path)} title={row.node.path}>
              <span class="chevron">{collapsed().has(row.node.path) ? '▸' : '▾'}</span>
              <span class="name">{row.node.name}</span>
            </div>
          ) : (
            <FileRow node={row.node} depth={row.depth} current={isCurrent(row.node.index)} />
          )
        }
      </For>
    </nav>
  );
}

function FileRow(p: { node: FileNode; depth: number; current: boolean }) {
  const f = p.node.file;
  return (
    <div
      class="entry leaf"
      classList={{ current: p.current }}
      style={`--depth:${p.depth}`}
      data-path={f.path}
      title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
      onClick={() => scrollToFile(p.node.index)}
    >
      <StatusBadge status={f.status} />
      <span class="name">{p.node.name}</span>
      <span class="counts">
        <Show when={!f.binary} fallback="bin">
          {f.add > 0 && <span class="plus">+{f.add}</span>} {f.del > 0 && <span class="minus">−{f.del}</span>}
        </Show>
      </span>
    </div>
  );
}
