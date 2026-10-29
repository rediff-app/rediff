<p align="center">
  <img src="assets/logo.svg" width="96" alt="rediff logo">
</p>

<h1 align="center">rediff</h1>

<p align="center"><strong>A redesigned way to review diffs.</strong></p>

<p align="center">English | <a href="README.zh-CN.md">简体中文</a></p>

A command-line tool for viewing git diffs in the browser. It ships as a single Rust binary with the frontend embedded, and opens your browser on startup.

```sh
rediff                      # working tree vs HEAD (including untracked files)
rediff --cached             # index vs HEAD
rediff main                 # working tree vs main
rediff main feature         # main vs feature
rediff HEAD~3..HEAD -- src  # a commit range, limited to a path
rediff --help               # all options: -U, --algorithm, --host, --port, --no-open, --no-watch ...
```

The page follows GitHub's Files changed layout: a filterable file tree on the left, and per-file diffs on the right. The History button in the top bar opens the commit list for the current branch (100 commits at a time, with more on demand). Click a commit to see its changes (against its first parent; a root commit is compared against the empty tree); the top entry returns to the diff given on the command line. When paths are given, the list only shows commits that touched those paths.

- **Diff view**: Unified / Split toggles between a unified and a side-by-side diff, and remembers your choice. Wrap is on by default: long lines wrap to the width of the code area, and both sides of the split view stay aligned. With Wrap off, use the horizontal scrollbar at the bottom, a trackpad swipe, or Shift + wheel to see the full code (both sides scroll together), while file headers and line numbers stay fixed. The wrap preference is saved.
- **File navigation**: filter by path (also matches the pre-rename path); the toolbar has previous / next file and collapse / expand all. On narrow screens the file tree and commit list open as floating panels.
- **Review progress**: checking Viewed collapses a file, and Hide viewed files hides the ones you've read. Marks are kept per comparison and file version for the current page session: they clear automatically when a file's content changes, and are lost on reload.
- **Lines and paths**: click a line number to highlight a line, Shift + click to select a range on the same side; copy a file's full path from next to its header.
- **Keyboard shortcuts**: `j` / `k` to move between files, `/` to filter, `v` to mark as viewed, `c` to collapse / expand, `?` for help. Navigation shortcuts don't fire while typing in an input.

On startup it prints two addresses: a local one (`local`) and a LAN one (`network`, the IP of the interface on the default route). When running on a remote dev machine, you can open the `network` address directly in the browser on your own computer. The URL carries a one-time token; the API can't be read without it. Add `--host 127.0.0.1` for local-only access.

Note that LAN access is plain HTTP: anyone on the same network who can sniff traffic can see the token and the diff contents. On untrusted networks, use `--host 127.0.0.1` with SSH port forwarding.

## Install

macOS / Linux:

```sh
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/rediff-app/rediff/releases/latest/download/rediff-installer.sh | sh
```

Windows (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -c "irm https://github.com/rediff-app/rediff/releases/latest/download/rediff-installer.ps1 | iex"
```

This installs to `~/.cargo/bin` along with `rediff-update`; run it later to upgrade to the latest release. You can also download the archive for your platform from the [Releases](https://github.com/rediff-app/rediff/releases) page.

## Build

Requirements: Rust (stable), Node.js 20+, git.

```sh
make build        # build the frontend + release binary -> target/release/rediff
make install      # install to ~/.cargo/bin
make test         # Rust unit tests + frontend type check and layout tests
```

## Development

Two workflows:

1. **Frequent frontend changes**: `make dev-web` (vite build --watch) + `cargo run -- <args>`. Debug builds read `web/dist` from disk at runtime, so after a frontend change just reload the page; no Rust rebuild needed.
2. **With HMR**: `cargo run -- --port 7777 --no-open` + `cd web && npm run dev`, then open the URL printed in the terminal with the origin replaced by `http://localhost:5173` (i.e. `http://localhost:5173/auth?token=...`). Vite proxies `/api` and `/auth` to port 7777.

## Layout

```
src/
  main.rs     CLI arguments, starting the server, opening the browser
  git.rs      git commands: file list (--raw --numstat -z), per-file patch, untracked files, commit list
  patch.rs    parses a patch into a compact line array + inline (word-level) diff
  server.rs   axum routes, token auth, diff cache, per-commit file list cache, SSE push
  watch.rs    watches the working tree / index / refs and pushes changes to the frontend
  assets.rs   frontend assets embedded with rust-embed
web/src/
  store.ts          file list, on-demand diff loading queue, collapse state, selected commit
  Commits.tsx       commit list (leftmost column)
  Sidebar.tsx       directory tree sidebar (single-child directory chains compacted, collapsible directories)
  tree.ts           tree sorting and building: directories first at each level, natural sort; the diff area uses the same order
  DiffView.tsx      two-level virtual scrolling (files + lines)
  diffRows.ts       side-by-side line alignment and horizontal scroll width estimation
  rowLayout.ts      variable row height index, enabling virtual scrolling with wrapped lines
  render.ts         merges syntax tokens and word-level diff into one line of HTML
  highlight*.ts     shiki running in a Web Worker, languages lazy-loaded on demand
```

## Performance design

- **git commands instead of libgit2**: status/diff are faster on large repos (fsmonitor, untracked cache), and `.gitattributes`, rename detection, etc. behave exactly like git. `GIT_OPTIONAL_LOCKS=0` is set so running in the background never rewrites the index.
- **The diff algorithm follows the repo's `diff.algorithm` by default** (myers if unset), matching what `git diff` shows. Histogram isn't forced because older git versions' histogram degrades badly on some inputs: on git 2.20, a 200k-line file with every other line changed takes 0.14 s with myers, while histogram doesn't finish in 30 s. Each per-file diff has a 60 s timeout as a fallback.
- **On-demand loading**: the first screen only requests the file list; a file's diff is requested when it scrolls into view, with at most 4 requests in flight and the visible area prioritized. Very large files and lockfiles are collapsed by default.
- **Content-addressed caching**: each file has a `version` (the oid pair when both sides are git objects, mtime+size for working tree files). The server keeps an LRU cache keyed by `path + version` (capped at 128 MB); when both sides are objects the response carries `Cache-Control: immutable`, and working tree files get an ETag and 304s.
- **Compact data format**: each line is a `[kind, old, new, text, inline?]` array rather than an object, then compressed with gzip/br/zstd (fast levels only).
- **The frontend only renders visible lines**: DOM nodes are reused per row object. Wrapped line heights are estimated first, then corrected from the measured height of the visible code; a variable row height index locates the viewport, so both single-row height updates and lookups are O(log n). Toggling wrap, switching views, or resizing the window anchors the position to a code line; diffs with huge numbers of lines still render only the rows near the viewport.
- **Syntax highlighting stays off the main thread**: shiki uses its JS regex engine (no wasm) and highlights whole files in a Worker; results are emitted as classes, merged, and written with a single innerHTML.
- **Live refresh**: on Linux, inotify watches are added only for directories that aren't ignored (so `node_modules` and `target` don't exhaust the watch quota). Events are debounced and pushed over SSE; the frontend refetches only files whose version changed.

## Benchmarks (505 files, one of them with 200k changed lines)

| Item | Result |
|---|---|
| File list `/api/files` (cache hit) | < 1 ms |
| The file with 200k changed lines (300k lines, 9.1 MB JSON), first request | 288 ms |
| Same file again (server cache) | 2.7 ms |
| Same file, zstd-compressed | 417 KB, 28 ms |
| Page open to first rows shown (headless Chromium) | ≈ 130 ms |
| Scrolling 1500px per frame in that file, 200 times | median 16.5 ms per frame (capped by the 60Hz refresh rate), at most 123 rows in the DOM |
| File change to new content on the page | ≈ 330 ms |

## Known limitations

- Browsers cap element height (about 33 million px in Chrome). Once all expanded files together exceed roughly 1.5 million display lines, the content at the end can't be scrolled to; wrapping increases the number of display lines.
- Lines are virtually rendered, so a text selection spanning many screens is lost after scrolling.
- Syntax highlighting tokenizes the concatenated hunks as a whole, so when a hunk starts in the middle of a multi-line comment or string, the first few lines may be colored incorrectly.
