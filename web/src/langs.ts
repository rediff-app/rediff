/** File extension → shiki language id. Every id here needs a loader in highlight.worker.ts. */
const BY_EXT: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  json: 'json', jsonc: 'jsonc',
  md: 'markdown', mdx: 'markdown',
  css: 'css', scss: 'scss', less: 'less',
  html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte',
  py: 'python', pyi: 'python',
  rs: 'rust', go: 'go',
  java: 'java', kt: 'kotlin', kts: 'kotlin', scala: 'scala', swift: 'swift', dart: 'dart',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', cs: 'csharp',
  rb: 'ruby', php: 'php', lua: 'lua', zig: 'zig',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini', xml: 'xml',
  sql: 'sql', proto: 'proto', graphql: 'graphql', gql: 'graphql',
};

const BY_NAME: Record<string, string> = {
  Dockerfile: 'docker',
  Makefile: 'make',
  'CMakeLists.txt': 'cmake',
};

export function langFor(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name in BY_NAME) return BY_NAME[name];
  const dot = name.lastIndexOf('.');
  return dot > 0 ? BY_EXT[name.slice(dot + 1).toLowerCase()] : undefined;
}
