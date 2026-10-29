import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js';
import { codeHtml } from './render';
import { codeColumns, splitRows, textColumns } from './diffRows';
import { Icon } from './Icon';
import { RowLayout } from './rowLayout';
import {
  current,
  visibleFiles as files,
  diffView,
  getLoaded,
  isCollapsed,
  isViewed,
  itemAt,
  setCurrent,
  setScrollImpl,
  toggleCollapsed,
  toggleViewed,
  want,
  wrapLines,
  type Loaded,
  type RowItem,
} from './store';
import { ADD, DEL, HUNK, type FileEntry } from './types';

// One visual line and the file header. Keep in sync with style.css.
export const LINE_H = 22;
export const HEADER_H = 48;
const GAP = 16;
const TOP_PAD = 16;
/** Pixels rendered beyond the viewport on each side. */
const OVERSCAN = 800;

const ROW_CLASS = ['row', 'row add', 'row del', 'row hunk'];
interface SplitItem extends RowItem { left: number; right: number }
const splitCache = new WeakMap<Loaded, SplitItem[]>();
const widthCache = new WeakMap<Loaded, number>();
const textWidthCache = new WeakMap<Loaded, number[]>();
const splitIndexCache = new WeakMap<Loaded, Int32Array>();
function splitItems(l: Loaded): SplitItem[] {
  let items = splitCache.get(l);
  if (!items) {
    items = splitRows(l.diff?.rows ?? []).map(([left, right], i) => ({ l, i, left, right }));
    splitCache.set(l, items);
    const indices = new Int32Array(l.diff?.rows.length ?? 0);
    for (const item of items) {
      if (item.left >= 0) indices[item.left] = item.i;
      if (item.right >= 0) indices[item.right] = item.i;
    }
    splitIndexCache.set(l, indices);
  }
  return items;
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
  let fontProbe!: HTMLSpanElement;
  let scrollbar: HTMLDivElement | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(window.innerHeight);
  const [viewW, setViewW] = createSignal(window.innerWidth);
  const [charWidth, setCharWidth] = createSignal(7.2);
  const [gutter, setGutter] = createSignal(window.innerWidth <= 600 ? 18 : 34);
  const [horizontal, setHorizontal] = createSignal(0);
  createEffect(on([diffView, wrapLines], () => {
    setHorizontal(0);
    scroller.scrollLeft = 0;
    if (scrollbar) scrollbar.scrollLeft = 0;
  }));

  type Metrics = { key: string; rows: RowLayout; overflow: number };
  const metricsCache = new WeakMap<Loaded, Metrics>();
  const [measureTick, setMeasureTick] = createSignal(0);
  const metrics = (l: Loaded): Metrics => {
    measureTick();
    const split = diffView() === 'split';
    const wrap = wrapLines();
    const width = Math.max(1, viewW() - gutter());
    const key = `${split}:${wrap}:${width}:${charWidth()}`;
    let cached = metricsCache.get(l);
    if (cached?.key === key) return cached;
    let widths = textWidthCache.get(l);
    if (!widths) {
      widths = (l.diff?.rows ?? []).map((r) => textColumns(r[3]));
      textWidthCache.set(l, widths);
    }
    const available = (split ? (width - 1) / 2 : width) / charWidth() - (l.digits + 2) * (split ? 1 : 2) - 4.5;
    const lines = (i: number) => {
      if (!wrap || i < 0) return 1;
      const columns = l.diff!.rows[i][0] === HUNK
        ? width / charWidth() - (l.digits + 2) * (split ? 1 : 2) - 4.5
        : available;
      return Math.max(1, Math.ceil(widths![i] / Math.max(1, Math.floor(columns))));
    };
    const heights = split
      ? splitItems(l).map((r) => Math.max(lines(r.left), lines(r.right)) * LINE_H)
      : widths.map((_, i) => lines(i) * LINE_H);
    cached = { key, rows: new RowLayout(heights), overflow: 0 };
    metricsCache.set(l, cached);
    return cached;
  };
  const bodyHeight = (f: FileEntry): number => {
    if (isCollapsed(f)) return 0;
    const l = getLoaded(f.path);
    if (!l) {
      const changed = f.add + f.del;
      return (f.binary ? 1 : Math.max(1, changed + 7 * Math.ceil(changed / 30))) * LINE_H;
    }
    const rows = metrics(l).rows;
    return Math.max(LINE_H, rows.offset(rows.length));
  };
  const overflow = createMemo(() => {
    if (wrapLines()) return 0;
    let width = 0;
    for (const f of files()) {
      const l = getLoaded(f.path);
      if (!l?.diff || isCollapsed(f)) continue;
      let size = widthCache.get(l);
      if (size === undefined) { size = codeColumns(l.diff.rows); widthCache.set(l, size); }
      const split = diffView() === 'split';
      const cellWidth = (viewW() - gutter()) / (split ? 2 : 1);
      const estimate = (size + (l.digits + 2) * (split ? 1 : 2) + 4.5) * charWidth() - cellWidth;
      width = Math.max(width, estimate, metrics(l).overflow);
    }
    return Math.ceil(width);
  });
  createEffect(on(overflow, (max) => {
    const next = Math.min(horizontal(), max);
    if (next === horizontal()) return;
    setHorizontal(next);
    if (scrollbar) scrollbar.scrollLeft = next;
  }));
  let measureFrame = 0;
  const pending = new Map<Metrics, Map<number, number>>();
  const measureRow = (item: RowItem, height: number, excess: number) => {
    if (('left' in item) !== (diffView() === 'split')) return;
    const m = metrics(item.l);
    const next = wrapLines() ? Math.max(LINE_H, height) : LINE_H;
    if (m.rows.height(item.i) === next && excess <= m.overflow) return;
    m.overflow = Math.max(m.overflow, excess);
    let changes = pending.get(m);
    if (!changes) { changes = new Map(); pending.set(m, changes); }
    changes.set(item.i, next);
    if (measureFrame) return;
    measureFrame = requestAnimationFrame(() => {
      measureFrame = 0;
      for (const [metric, changes] of pending) {
        for (const [i, h] of changes) metric.rows.setHeight(i, h);
      }
      pending.clear();
      setMeasureTick((n) => n + 1);
    });
  };
  onCleanup(() => cancelAnimationFrame(measureFrame));
  type Selection = { path: string; version: string; side: 'old' | 'new'; start: number; end: number };
  const [selection, setSelection] = createSignal<Selection>();
  const pickLine = (l: Loaded, side: 'old' | 'new', line: number, extend: boolean) => {
    const prev = selection();
    setSelection({ path: l.path, version: l.version, side, start: extend && prev?.path === l.path && prev.version === l.version && prev.side === side ? prev.start : line, end: line });
  };
  const selectedLine = (l: Loaded, row: number) => {
    const s = selection();
    if (!s || s.path !== l.path || s.version !== l.version || row < 0) return false;
    const n = l.diff!.rows[row][s.side === 'old' ? 1 : 2];
    return n > 0 && n >= Math.min(s.start, s.end) && n <= Math.max(s.start, s.end);
  };
  /** The file at the top of the viewport and how far into it we are; kept in place when heights change. */
  let anchor: { path: string; offset: number; sourceRow?: number; within?: number } = { path: '', offset: 0 };
  /**
   * The scrollTop we last set ourselves. The scroll event it causes must not
   * move the anchor: near the end the browser clamps scrollTop, and the file
   * found there is not the one we were asked to show.
   */
  let ownTop = -1;
  const scrollTo = (y: number) => {
    scroller.scrollTop = y;
    ownTop = scroller.scrollTop;
    setScrollTop(ownTop);
  };

  const index = createMemo(() => new Map(files().map((f, i) => [f.path, i])));

  /** tops[i] is where file i starts; tops[n] is the total height. */
  const layout = createMemo(() => {
    const fs = files();
    const tops = new Float64Array(fs.length + 1);
    tops[0] = TOP_PAD;
    for (let i = 0; i < fs.length; i++) {
      tops[i + 1] = tops[i] + HEADER_H + bodyHeight(fs[i]) + GAP;
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
      const positions = l ? metrics(l).rows : undefined;
      const n = positions?.length ?? 0;
      if (!l || !n) continue;
      const rowsTop = tops[i] + HEADER_H;
      const first = positions!.at(top - rowsTop);
      const last = Math.min(n, positions!.at(bottom - rowsTop) + 1);
      for (let r = first; r < last; r++) rows.push(diffView() === 'split' ? splitItems(l)[r] : itemAt(l, r));
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
        if (i === undefined) {
          anchor = { path: files()[0]?.path ?? '', offset: 0 };
          setCurrent(0);
          scrollTo(0);
          setScrollTop(0);
          return;
        }
        setCurrent(i);
        let offset = anchor.offset;
        const l = getLoaded(anchor.path);
        if (anchor.sourceRow !== undefined && l?.diff?.rows.length && !isCollapsed(files()[i])) {
          const source = Math.min(anchor.sourceRow, l.diff.rows.length - 1);
          const row = diffView() === 'split' ? splitIndexCache.get(l)![source] : source;
          const positions = metrics(l).rows;
          offset = HEADER_H + positions.offset(row) + Math.min(anchor.within ?? 0, positions.height(row) - 1);
        }
        const target = tops[i] + Math.min(offset, tops[i + 1] - tops[i]);
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
      const l = getLoaded(anchor.path);
      if (anchor.offset >= HEADER_H && l?.diff?.rows.length && !isCollapsed(files()[i])) {
        const positions = metrics(l).rows;
        const row = positions.at(anchor.offset - HEADER_H);
        const item = diffView() === 'split' ? splitItems(l)[row] : undefined;
        anchor.sourceRow = item ? (item.left >= 0 ? item.left : item.right) : row;
        anchor.within = anchor.offset - HEADER_H - positions.offset(row);
      }
      setCurrent(i);
    }
  };

  onMount(() => {
    setCurrent(0);
    anchor = { path: files()[0]?.path ?? '', offset: -TOP_PAD };
    const ro = new ResizeObserver(() => {
      setViewH(scroller.clientHeight);
      setViewW(scroller.clientWidth);
      setCharWidth(fontProbe.getBoundingClientRect().width / 10 || 7.2);
      setGutter(window.innerWidth <= 600 ? 18 : 34);
    });
    ro.observe(scroller);
    ro.observe(fontProbe);
    onCleanup(() => ro.disconnect());
    setScrollImpl((i) => {
      anchor = { path: files()[i].path, offset: 0 };
      setCurrent(i);
      scrollTo(layout()[i]);
    });
    onCleanup(() => setScrollImpl(() => {}));
  });

  // The header of the file at the top, while its own header is scrolled out of view.
  const sticky = createMemo(() => {
    const f = files()[current()];
    return f && scrollTop() > topOf(f.path) ? f : undefined;
  });

  return (
    <div class="pane" classList={{ 'split-view': diffView() === 'split', 'wrap-lines': wrapLines(), 'has-horizontal-scroll': !wrapLines() && overflow() > 0 }} style={{ '--code-scroll': `${-horizontal()}px` }}>
      <span class="code-measure" ref={fontProbe} aria-hidden="true">0000000000</span>
      <div class="scroller" ref={scroller} onScroll={onScroll} tabindex="0" aria-label="File differences" onWheel={(e) => {
        if (wrapLines() || (!e.deltaX && !e.shiftKey)) return;
        if (scrollbar && overflow() > 0) {
          scrollbar.scrollLeft += e.deltaX || e.deltaY;
          e.preventDefault();
        }
      }}>
        <div class="canvas" style={{ height: `${layout()[files().length]}px` }}>
          <For each={visible().blocks}>{(f) => <FileBlock f={f} top={() => topOf(f.path)} bodyHeight={() => bodyHeight(f)} />}</For>
          <For each={visible().rows}>
            {(item) => <RowView
              item={item}
              top={() => topOf(item.l.path) + HEADER_H + metrics(item.l).rows.offset(item.i)}
              height={() => metrics(item.l).rows.height(item.i)}
              measure={(height, excess) => measureRow(item, height, excess)}
              selected={(i) => selectedLine(item.l, i)}
              pick={(side, line, extend) => pickLine(item.l, side, line, extend)}
            />}
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
      <Show when={!wrapLines() && overflow() > 0}>
        <div class="code-scrollbar" ref={scrollbar} tabindex="0" aria-label={diffView() === 'split' ? 'Scroll both code columns horizontally' : 'Scroll code horizontally'} onScroll={(e) => setHorizontal(e.currentTarget.scrollLeft)}><div style={{ width: `calc(100% + ${overflow()}px)` }} /></div>
      </Show>
    </div>
  );
}

function FileHeader(p: { f: FileEntry }) {
  const [copyState, setCopyState] = createSignal('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  const copyPath = async () => {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(p.f.path);
      else {
        // LAN HTTP pages do not expose navigator.clipboard.
        const input = document.createElement('textarea');
        input.value = p.f.path;
        input.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        document.body.append(input);
        const previous = document.activeElement;
        let copied = false;
        try { input.select(); copied = document.execCommand('copy'); }
        finally { input.remove(); if (previous instanceof HTMLElement) previous.focus(); }
        if (!copied) throw new Error('Clipboard unavailable');
      }
      setCopyState('Copied!');
    } catch { setCopyState('Copy failed'); }
    clearTimeout(timer);
    timer = setTimeout(() => setCopyState(''), 2000);
  };
  return (
    <div class="file-header" classList={{ viewed: isViewed(p.f), collapsed: isCollapsed(p.f) }}>
      <button class="file-toggle" onClick={() => toggleCollapsed(p.f)} aria-expanded={!isCollapsed(p.f)} aria-label={`${isCollapsed(p.f) ? 'Expand' : 'Collapse'} ${p.f.path}`}>
        <Icon name="chevron" class={isCollapsed(p.f) ? 'chevron' : 'chevron open'} size={14} />
        <StatusBadge status={p.f.status} />
        <span class="path" title={p.f.oldPath ? `${p.f.oldPath} → ${p.f.path}` : p.f.path}>{p.f.oldPath ? `${p.f.oldPath} → ${p.f.path}` : p.f.path}</span>
      </button>
      <button class="icon-button copy-path" aria-label={`Copy path ${p.f.path}`} title={copyState() || 'Copy file path'} onClick={copyPath}><Icon name={copyState() === 'Copied!' ? 'check' : 'copy'} size={14} /><Show when={copyState()}><span class="copy-feedback" role="status">{copyState()}</span></Show></button>
      <span class="counts">
        <Show when={!p.f.binary} fallback="binary">
          <span class="plus">+{p.f.add}</span> <span class="minus">−{p.f.del}</span>
        </Show>
      </span>
      <label class="viewed-control" title="Mark this file as viewed (v)"><input type="checkbox" aria-label={`Mark ${p.f.path} as viewed`} checked={isViewed(p.f)} onChange={() => toggleViewed(p.f)} /><span>Viewed</span></label>
    </div>
  );
}

const BADGE: Record<string, string> = { '?': 'U', U: '!' };
const BADGE_CLASS: Record<string, string> = { A: 'add', '?': 'add', D: 'del', U: 'del', R: 'ren', C: 'ren' };

export function StatusBadge(p: { status: string }) {
  const labels: Record<string, string> = { A: 'Added', '?': 'Untracked', D: 'Deleted', M: 'Modified', U: 'Unmerged', R: 'Renamed', C: 'Copied', T: 'Type changed' };
  return <span class={`badge ${BADGE_CLASS[p.status] ?? 'mod'}`} title={labels[p.status] ?? p.status} aria-label={labels[p.status] ?? p.status}>{BADGE[p.status] ?? p.status}</span>;
}

function FileBlock(p: { f: FileEntry; top: () => number; bodyHeight: () => number }) {
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
    <div class="file" style={{ top: `${p.top()}px`, height: `${HEADER_H + p.bodyHeight() + 1}px` }}>
      <FileHeader f={p.f} />
      <Show when={message()}>{(m) => <div class="file-message">{m()}</div>}</Show>
    </div>
  );
}

function RowView(p: {
  item: RowItem;
  top: () => number;
  height: () => number;
  measure: (height: number, overflow: number) => void;
  selected: (i: number) => boolean;
  pick: (side: 'old' | 'new', line: number, extend: boolean) => void;
}) {
  let element!: HTMLDivElement;
  const { l, i } = p.item;
  const style = () => `top:${p.top()}px;height:${p.height()}px;--digits:${l.digits}ch`;
  onMount(() => {
    const codes = [...element.querySelectorAll<HTMLElement>('.code')];
    const measure = () => {
      let height = LINE_H;
      let overflow = 0;
      for (const code of codes) {
        height = Math.max(height, code.getBoundingClientRect().height);
        overflow = Math.max(overflow, code.scrollWidth - code.parentElement!.clientWidth);
      }
      p.measure(Math.ceil(height), overflow);
    };
    const observer = new ResizeObserver(measure);
    for (const code of codes) {
      observer.observe(code);
      observer.observe(code.parentElement!);
    }
    onCleanup(() => observer.disconnect());
    measure();
  });
  const split = p.item as Partial<SplitItem>;
  if (split.left !== undefined && split.right !== undefined) {
    const left = split.left;
    const right = split.right;
    if (left >= 0 && l.diff!.rows[left][0] === HUNK) return <div ref={element} class="row hunk split-hunk" style={style()}><span class="code-clip"><span class="code">{l.diff!.rows[left][3]}</span></span></div>;
    const cell = (idx: number, side: 'old' | 'new') => {
      if (idx < 0) return <div class="split-cell empty" />;
      const [kind, oldNo, newNo, text, inline] = l.diff!.rows[idx];
      const n = side === 'old' ? oldNo : newNo;
      return <div class="split-cell" classList={{ add: kind === ADD, del: kind === DEL, selected: p.selected(idx) }}><button class="ln" data-n={n} aria-label={`Select ${side} line ${n}`} onClick={(e) => p.pick(side, n, e.shiftKey)} /><span class="code-clip"><span class="code" innerHTML={codeHtml(text, l.tokens()?.[idx], inline)} /></span></div>;
    };
    return <div ref={element} class="row split-row" style={style()}>{cell(left, 'old')}{cell(right, 'new')}</div>;
  }
  const [kind, oldNo, newNo, text, inline] = l.diff!.rows[i];
  if (kind === HUNK) {
    return (
      <div ref={element} class={ROW_CLASS[kind]} style={style()}>
        <span class="code-clip"><span class="code">{text}</span></span>
      </div>
    );
  }
  return (
    <div ref={element} class={ROW_CLASS[kind]} classList={{ selected: p.selected(i) }} style={style()}>
      <Show when={kind !== ADD && oldNo > 0} fallback={<span class="ln" />}><button class="ln" data-n={oldNo} aria-label={`Select old line ${oldNo}`} onClick={(e) => p.pick('old', oldNo, e.shiftKey)} /></Show>
      <Show when={kind !== DEL && newNo > 0} fallback={<span class="ln" />}><button class="ln" data-n={newNo} aria-label={`Select new line ${newNo}`} onClick={(e) => p.pick('new', newNo, e.shiftKey)} /></Show>
      <span class="code-clip"><span class="code" innerHTML={codeHtml(text, l.tokens()?.[i], inline)} /></span>
    </div>
  );
}
