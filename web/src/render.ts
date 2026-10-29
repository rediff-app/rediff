import type { LineTokens } from './highlight';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const escape = (s: string) => s.replace(/[&<>]/g, (c) => ESC[c]);

/**
 * HTML for one line of code: syntax tokens (classes .tN) overlaid with
 * changed-word ranges (class .x). Building a string and setting innerHTML
 * once is much cheaper than creating a span node per token.
 */
export function codeHtml(text: string, tokens?: LineTokens, inline?: number[]): string {
  const n = text.length;
  let html = '';
  let pos = 0;
  // current syntax token: [.., tEnd), style id cls (-1 = none)
  let ti = 0;
  let tEnd = tokens?.length ? tokens[0] : n;
  let cls = tokens?.length ? tokens[1] : -1;
  let ii = 0;
  while (pos < n) {
    while (pos >= tEnd) {
      if (tokens && ti + 2 < tokens.length) {
        ti += 2;
        tEnd += tokens[ti];
        cls = tokens[ti + 1];
      } else {
        tEnd = n;
        cls = -1;
      }
    }
    while (inline && ii < inline.length && pos >= inline[ii + 1]) ii += 2;
    const marked = !!inline && ii < inline.length && pos >= inline[ii];
    const markEdge = !inline || ii >= inline.length ? n : marked ? inline[ii + 1] : inline[ii];
    const end = Math.min(tEnd, markEdge);

    const piece = escape(text.slice(pos, end));
    const classes = cls >= 0 ? (marked ? `t${cls} x` : `t${cls}`) : marked ? 'x' : '';
    html += classes ? `<span class="${classes}">${piece}</span>` : piece;
    pos = end;
  }
  return html;
}
