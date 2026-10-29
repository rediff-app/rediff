import type { FileEntry } from './types';

export interface DirNode {
  kind: 'dir';
  /** full path of the deepest directory in a compacted chain; the collapse key */
  path: string;
  /** shown name; a chain of single-child directories reads "a/b/c" */
  name: string;
  children: TreeNode[];
}

export interface FileNode {
  kind: 'file';
  file: FileEntry;
  /** position in the (tree-ordered) file list */
  index: number;
  name: string;
}

export type TreeNode = DirNode | FileNode;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * Sorts files the way the tree shows them: per level, directories before
 * files, names in natural order. The diff pane uses the same order, so the
 * tree, j/k navigation and the scroll position all agree.
 */
export function treeOrder(files: FileEntry[]): FileEntry[] {
  const keyed = files.map((f) => ({ f, parts: f.path.split('/') }));
  keyed.sort((a, b) => {
    const n = Math.min(a.parts.length, b.parts.length);
    for (let i = 0; i < n; i++) {
      if (a.parts[i] === b.parts[i]) continue;
      const aDir = i < a.parts.length - 1;
      const bDir = i < b.parts.length - 1;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return collator.compare(a.parts[i], b.parts[i]) || (a.parts[i] < b.parts[i] ? -1 : 1);
    }
    return a.parts.length - b.parts.length;
  });
  return keyed.map((k) => k.f);
}

/** Builds the tree of files already in treeOrder. */
export function buildTree(files: FileEntry[]): DirNode {
  const root: DirNode = { kind: 'dir', path: '', name: '', children: [] };
  const dirs = new Map<string, DirNode>([['', root]]);
  files.forEach((file, index) => {
    const parts = file.path.split('/');
    let parent = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let dir = dirs.get(path);
      if (!dir) {
        dir = { kind: 'dir', path, name: parts[i], children: [] };
        dirs.set(path, dir);
        parent.children.push(dir);
      }
      parent = dir;
    }
    parent.children.push({ kind: 'file', file, index, name: parts[parts.length - 1] });
  });
  compact(root);
  return root;
}

function compact(dir: DirNode) {
  for (const child of dir.children) {
    if (child.kind !== 'dir') continue;
    while (child.children.length === 1 && child.children[0].kind === 'dir') {
      const only = child.children[0];
      child.name += `/${only.name}`;
      child.path = only.path;
      child.children = only.children;
    }
    compact(child);
  }
}
