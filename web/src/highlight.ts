import HighlightWorker from './highlight.worker?worker';

/** Per line: flat [length, styleId, length, styleId, ...] */
export type LineTokens = number[];
export interface HighlightResult {
  old: LineTokens[];
  new: LineTokens[];
}
export type Style = [id: number, light: string, dark: string, fontStyle: number];
export interface HighlightRequest {
  id: number;
  lang: string;
  old: string[];
  new: string[];
}
export interface HighlightReply extends HighlightResult {
  id: number;
  /** styles first used by this reply */
  styles: Style[];
}

let worker: Worker | undefined;
let seq = 0;
const pending = new Map<number, (r: HighlightResult | undefined) => void>();

// Token colors become classes (.t0, .t1, ...) instead of inline styles: less DOM work per row.
const sheet = new CSSStyleSheet();
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

function addStyle([id, light, dark, fontStyle]: Style) {
  const font =
    (fontStyle & 1 ? 'font-style:italic;' : '') +
    (fontStyle & 2 ? 'font-weight:600;' : '') +
    (fontStyle & 4 ? 'text-decoration:underline;' : '');
  sheet.insertRule(`.t${id}{${light ? `color:${light};` : ''}${font}}`, sheet.cssRules.length);
  if (dark) sheet.insertRule(`@media (prefers-color-scheme: dark){.t${id}{color:${dark}}}`, sheet.cssRules.length);
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new HighlightWorker();
  worker.onmessage = (e: MessageEvent<HighlightReply>) => {
    e.data.styles.forEach(addStyle);
    pending.get(e.data.id)?.(e.data);
    pending.delete(e.data.id);
  };
  worker.onerror = (e) => {
    console.error('highlight worker failed', e);
    for (const resolve of pending.values()) resolve(undefined);
    pending.clear();
  };
  return worker;
}

/** Tokenizes both sides of a diff off the main thread. */
export function highlight(lang: string, oldLines: string[], newLines: string[]): Promise<HighlightResult | undefined> {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    const req: HighlightRequest = { id, lang, old: oldLines, new: newLines };
    getWorker().postMessage(req);
  });
}
