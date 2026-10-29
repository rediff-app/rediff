import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { codeHtml } from './render';
import {
  current,
  files,
  getLoaded,
  isCollapsed,
  itemAt,
  setCurrent,
  setScrollImpl,
  toggleCollapsed,
  want,
  type Loaded,
  type RowItem,
} from './store';
import { ADD, DEL, HUNK, type FileEntry } from './types';

// Every row has the same height, so positions are plain arithmetic. Keep in sync with style.css.
export const LINE_H = 20;
export const HEADER_H = 40;
const GAP = 16;
const TOP_PAD = 16;
/** Pixels rendered beyond the viewport on each side. */
const OVERSCAN = 800;

const ROW_CLASS = ['row', 'row add', 'row del', 'row hunk'];

/** Rows a file block shows: its diff, a one-line message, or a guess while loading. */
function bodyRows(f: FileEntry, l: Loaded | undefined): number {
  if (isCollapsed(f)) return 0;
  if (!l) {
    if (f.binary) return 1;
    // Changed lines plus a guess at hunk headers and context.
    const changed = f.add + f.del;
    return Math.max(1, changed + 7 * Math.ceil(changed / 30));
  }
  return Math.max(1, l.diff?.binary ? 0 : (l.diff?.rows.length ?? 0));
}

/** Index of the last file starting at or above y. */
function fileAt(tops: Float64Array, y: number): number {
  let lo = 0;
  let hi = tops.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function DiffView() {
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(window.innerHeight);
  /** The file at the top of the viewport and how far into it we are; kept in place when heights change. */
  let anchor = { path: '', offset: 0 };
  /**
   * The scrollTop we last set ourselves. The scroll event it causes must not
   * move the anchor: near the end the browser clamps scrollTop, and the file
   * found there is not the one we were asked to show.
   */
  let ownTop = -1;
  const scrollTo = (y: number) => {
    scroller.scrollTop = y;
    ownTop = scroller.scrollTop;
  };

  const index = createMemo(() => new Map(files().map((f, i) => [f.path, i])));

  /** tops[i] is where file i starts; tops[n] is the total height. */
  const layout = createMemo(() => {
    const fs = files();
    const tops = new Float64Array(fs.length + 1);
    tops[0] = TOP_PAD;
    for (let i = 0; i < fs.length; i++) {
      tops[i + 1] = tops[i] + HEADER_H + bodyRows(fs[i], getLoaded(fs[i].path)) * LINE_H + GAP;
    }
    return tops;
  });
  const topOf = (path: string) => layout()[index().get(path) ?? 0];

  const visible = createMemo(() => {
    const tops = layout();
    const fs = files();
    const top = scrollTop() - OVERSCAN;
    const bottom = scrollTop() + viewH() + OVERSCAN;
    const blocks: FileEntry[] = [];
    const rows: RowItem[] = [];
    const wanted: FileEntry[] = [];
    for (let i = fileAt(tops, top); i < fs.length && tops[i] < bottom; i++) {
      const f = fs[i];
      blocks.push(f);
      if (isCollapsed(f)) continue;
      const l = getLoaded(f.path);
      if (l?.version !== f.version) wanted.push(f);
      // A stale diff stays on screen until its replacement arrives.
      const n = l?.diff?.rows.length ?? 0;
      if (!l || !n) continue;
      const rowsTop = tops[i] + HEADER_H;
      const first = Math.max(0, Math.floor((top - rowsTop) / LINE_H));
      const last = Math.min(n, Math.ceil((bottom - rowsTop) / LINE_H));
      for (let r = first; r < last; r++) rows.push(itemAt(l, r));
    }
    return { blocks, rows, wanted };
  });
  createEffect(() => want(visible().wanted));

  // When blocks above the viewport change height (a diff arrived, a file was
  // collapsed), keep the content under the viewport where it was.
  createEffect(
    on(
      layout,
      (tops) => {
        const i = index().get(anchor.path);
        if (i === undefined) return;
        const target = tops[i] + Math.min(anchor.offset, tops[i + 1] - tops[i]);
        if (Math.abs(scroller.scrollTop - target) > 1) scrollTo(target);
      },
      { defer: true },
    ),
  );

  const onScroll = () => {
    const y = scroller.scrollTop;
    const tops = layout();
    const i = fileAt(tops, y);
    setScrollTop(y);
    if (Math.abs(y - ownTop) < 1) return;
    ownTop = -1;
    if (files().length) {
      anchor = { path: files()[i].path, offset: y - tops[i] };
      setCurrent(i);
    }
  };

  onMount(() => {
    const ro = new ResizeObserver(() => setViewH(scroller.clientHeight));
    ro.observe(scroller);
    onCleanup(() => ro.disconnect());
    setScrollImpl((i) => {
      anchor = { path: files()[i].path, offset: 0 };
      setCurrent(i);
      scrollTo(layout()[i]);
    });
  });

  // The header of the file at the top, while its own header is scrolled out of view.
  const sticky = createMemo(() => {
    const f = files()[current()];
    return f && scrollTop() > topOf(f.path) ? f : undefined;
  });

  return (
    <div class="pane">
      <div class="scroller" ref={scroller} onScroll={onScroll}>
        <div class="canvas" style={{ height: `${layout()[files().length]}px` }}>
          <For each={visible().blocks}>{(f) => <FileBlock f={f} top={() => topOf(f.path)} />}</For>
          <For each={visible().rows}>
            {(item) => <RowView item={item} top={() => topOf(item.l.path) + HEADER_H + item.i * LINE_H} />}
          </For>
        </div>
      </div>
      <Show when={sticky()} keyed>
        {(f) => (
          <div class="sticky">
            <FileHeader f={f} />
          </div>
        )}
      </Show>
    </div>
  );
}

function FileHeader(p: { f: FileEntry }) {
  return (
    <div class="file-header" onClick={() => toggleCollapsed(p.f)}>
      <span class="chevron">{isCollapsed(p.f) ? '▸' : '▾'}</span>
      <StatusBadge status={p.f.status} />
      <span class="path" title={p.f.path}>
        {p.f.oldPath ? `${p.f.oldPath} → ${p.f.path}` : p.f.path}
      </span>
      <span class="counts">
        <Show when={!p.f.binary} fallback="binary">
          <span class="plus">+{p.f.add}</span> <span class="minus">−{p.f.del}</span>
        </Show>
      </span>
    </div>
  );
}

const BADGE: Record<string, string> = { '?': 'U', U: '!' };
const BADGE_CLASS: Record<string, string> = { A: 'add', '?': 'add', D: 'del', U: 'del', R: 'ren', C: 'ren' };

export function StatusBadge(p: { status: string }) {
  return <span class={`badge ${BADGE_CLASS[p.status] ?? 'mod'}`}>{BADGE[p.status] ?? p.status}</span>;
}

function FileBlock(p: { f: FileEntry; top: () => number }) {
  const l = () => getLoaded(p.f.path);
  const message = () => {
    if (isCollapsed(p.f)) return undefined;
    const x = l();
    if (!x) return 'Loading…';
    if (x.error) return `Failed to load: ${x.error}`;
    if (x.diff?.binary) return 'Binary file not shown';
    if (!x.diff?.rows.length) return p.f.oldPath ? 'File renamed without changes' : 'No content changes';
  };
  return (
    <div class="file" style={{ top: `${p.top()}px`, height: `${HEADER_H + bodyRows(p.f, l()) * LINE_H + 1}px` }}>
      <FileHeader f={p.f} />
      <Show when={message()}>{(m) => <div class="file-message">{m()}</div>}</Show>
    </div>
  );
}

function RowView(p: { item: RowItem; top: () => number }) {
  const { l, i } = p.item;
  const [kind, oldNo, newNo, text, inline] = l.diff!.rows[i];
  const style = () => `top:${p.top()}px;--digits:${l.digits}ch`;
  if (kind === HUNK) {
    return (
      <div class={ROW_CLASS[kind]} style={style()}>
        <span class="code">{text}</span>
      </div>
    );
  }
  return (
    <div class={ROW_CLASS[kind]} style={style()}>
      <span class="ln" data-n={kind === ADD ? '' : oldNo} />
      <span class="ln" data-n={kind === DEL ? '' : newNo} />
      <span class="code" innerHTML={codeHtml(text, l.tokens()?.[i], inline)} />
    </div>
  );
}
