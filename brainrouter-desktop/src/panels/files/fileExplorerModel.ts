export interface FileTreeDirectory {
  dirs: Map<string, FileTreeDirectory>;
  files: string[];
}

export interface FileTreeRow {
  kind: 'directory' | 'file';
  path: string;
  name: string;
  depth: number;
  expanded?: boolean;
}

export interface VirtualRowWindow {
  start: number;
  end: number;
  offsetTop: number;
  totalHeight: number;
  virtualized: boolean;
}

export const FILE_TREE_ROW_HEIGHT = 24;
export const FILE_TREE_VIRTUALIZE_AT = 240;
export const FILE_TREE_OVERSCAN = 8;

export function buildFileTree(paths: readonly string[]): FileTreeDirectory {
  const root: FileTreeDirectory = { dirs: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split('/');
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      let next = node.dirs.get(parts[index]);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        node.dirs.set(parts[index], next);
      }
      node = next;
    }
    node.files.push(parts[parts.length - 1]);
  }
  return root;
}

export function flattenVisibleFileTree(
  root: FileTreeDirectory,
  expanded: ReadonlySet<string>,
): FileTreeRow[] {
  const rows: FileTreeRow[] = [];

  const visit = (directory: FileTreeDirectory, base: string, depth: number): void => {
    for (const name of [...directory.dirs.keys()].sort()) {
      const path = base ? `${base}/${name}` : name;
      const open = expanded.has(path);
      rows.push({ kind: 'directory', path, name, depth, expanded: open });
      if (open) visit(directory.dirs.get(name)!, path, depth + 1);
    }
    for (const name of [...directory.files].sort()) {
      rows.push({
        kind: 'file',
        path: base ? `${base}/${name}` : name,
        name,
        depth,
      });
    }
  };

  visit(root, '', 0);
  return rows;
}

export function calculateVirtualRowWindow(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
  rowHeight = FILE_TREE_ROW_HEIGHT,
  overscan = FILE_TREE_OVERSCAN,
  threshold = FILE_TREE_VIRTUALIZE_AT,
): VirtualRowWindow {
  const totalHeight = rowCount * rowHeight;
  if (rowCount <= threshold) {
    return { start: 0, end: rowCount, offsetTop: 0, totalHeight, virtualized: false };
  }

  const safeTop = Math.max(0, Math.min(scrollTop, Math.max(0, totalHeight - viewportHeight)));
  const start = Math.max(0, Math.floor(safeTop / rowHeight) - overscan);
  const visibleCount = Math.ceil(Math.max(rowHeight, viewportHeight) / rowHeight);
  const end = Math.min(rowCount, start + visibleCount + overscan * 2);
  return {
    start,
    end,
    offsetTop: start * rowHeight,
    totalHeight,
    virtualized: true,
  };
}
