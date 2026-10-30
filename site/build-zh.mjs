// Generates public/zh/index.html from the English page, so the Chinese version is
// plain HTML that search engines can index. Runs as part of the wrangler build.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const root = new URL('./', import.meta.url);
const zh = JSON.parse(readFileSync(new URL('zh.json', root), 'utf8'));
let html = readFileSync(new URL('public/index.html', root), 'utf8');
const unused = new Set(Object.keys(zh));

function translation(key) {
  if (!(key in zh)) throw new Error(`zh.json has no "${key}"`);
  unused.delete(key);
  return zh[key];
}

function replace(from, to) {
  if (!html.includes(from)) throw new Error(`not found in index.html: ${from}`);
  html = html.replaceAll(from, to);
}

// The title and description repeat in <head>, the Open Graph tags and the JSON-LD.
replace(html.match(/<title>(.*?)<\/title>/)[1], translation('meta.title'));
replace(html.match(/<meta name="description" content="(.*?)">/)[1], translation('meta.description'));
replace(html.match(/<meta property="og:image:alt" content="(.*?)">/)[1], translation('meta.image'));
replace('<html lang="en">', '<html lang="zh-CN">');
replace('<link rel="canonical" href="https://rediff.app/">', '<link rel="canonical" href="https://rediff.app/zh/">');
replace('<meta property="og:url" content="https://rediff.app/">', '<meta property="og:url" content="https://rediff.app/zh/">');
replace('<meta property="og:locale" content="en_US">', '<meta property="og:locale" content="zh_CN">');
replace('<meta property="og:locale:alternate" content="zh_CN">', '<meta property="og:locale:alternate" content="en_US">');
replace('<a class="lang" id="lang" href="/zh/" hreflang="zh-CN" lang="zh-CN" data-lang="zh">中文</a>', '<a class="lang" id="lang" href="/" hreflang="en" lang="en" data-lang="en">English</a>');
replace('<a class="brand" href="/">', '<a class="brand" href="/zh/">');

html = html.replace(/<(\w+)((?:\s[^>]*)?\sdata-i18n="([^"]+)"[^>]*)>[\s\S]*?<\/\1>/g, (_, tag, attrs, key) => `<${tag}${attrs}>${translation(key)}</${tag}>`);
html = html.replace(/aria-label="[^"]*" data-i18n-label="([^"]+)"/g, (_, key) => `aria-label="${translation(key)}" data-i18n-label="${key}"`);

if (unused.size) throw new Error(`unused keys in zh.json: ${[...unused].join(', ')}`);

mkdirSync(new URL('public/zh/', root), { recursive: true });
writeFileSync(new URL('public/zh/index.html', root), html);
