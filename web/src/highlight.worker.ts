import { createHighlighterCore, type HighlighterCore, type LanguageInput } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { HighlightReply, HighlightRequest, LineTokens, Style } from './highlight';

/** Every grammar is a separate chunk, fetched the first time a file needs it. */
const LANGS: Record<string, () => LanguageInput> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  zig: () => import('shiki/langs/zig.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  proto: () => import('shiki/langs/proto.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  docker: () => import('shiki/langs/docker.mjs'),
  make: () => import('shiki/langs/make.mjs'),
  cmake: () => import('shiki/langs/cmake.mjs'),
};

const THEMES = { light: 'github-light', dark: 'github-dark' };

let highlighter: Promise<HighlighterCore> | undefined;
const getHighlighter = () =>
  (highlighter ??= createHighlighterCore({
    themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
    langs: [],
    // Pure JS regexes: no 600 KB oniguruma wasm. `forgiving` skips the few patterns JS can't express.
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  }));

const styleIds = new Map<string, number>();

function tokenize(h: HighlighterCore, lines: string[], lang: string, newStyles: Style[]): LineTokens[] {
  if (!lines.length) return [];
  const tokenized = h.codeToTokensWithThemes(lines.join('\n'), {
    lang,
    themes: THEMES,
    // Minified lines can make TextMate grammars crawl; leave their tail plain.
    tokenizeMaxLineLength: 2000,
  });
  return tokenized.map((line) => {
    const out: LineTokens = [];
    let prev = -1;
    for (const t of line) {
      const light = t.variants.light ?? {};
      const dark = t.variants.dark ?? {};
      const fontStyle = light.fontStyle ?? 0;
      const key = `${light.color}|${dark.color}|${fontStyle}`;
      let id = styleIds.get(key);
      if (id === undefined) {
        id = styleIds.size;
        styleIds.set(key, id);
        newStyles.push([id, light.color ?? '', dark.color ?? '', fontStyle]);
      }
      // Merge neighbours with the same style: fewer spans to render.
      if (id === prev) out[out.length - 2] += t.content.length;
      else out.push(t.content.length, id);
      prev = id;
    }
    return out;
  });
}

self.onmessage = async (e: MessageEvent<HighlightRequest>) => {
  const { id, lang, old, new: neu } = e.data;
  const styles: Style[] = [];
  let reply: HighlightReply;
  try {
    const h = await getHighlighter();
    if (!h.getLoadedLanguages().includes(lang)) await h.loadLanguage(LANGS[lang]());
    reply = { id, styles, old: tokenize(h, old, lang, styles), new: tokenize(h, neu, lang, styles) };
  } catch (err) {
    console.warn(`rediff: cannot highlight ${lang}`, err);
    // Still send the styles: their ids are already taken.
    reply = { id, styles, old: [], new: [] };
  }
  self.postMessage(reply);
};
