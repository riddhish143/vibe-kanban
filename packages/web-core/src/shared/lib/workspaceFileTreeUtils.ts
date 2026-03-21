import type { TreeNode } from '@/shared/types/fileTree';
import type { WorkspaceRepoTreeEntry } from '@/shared/types/workspaceFiles';

export function buildWorkspaceFileTree(
  entries: WorkspaceRepoTreeEntry[]
): TreeNode[] {
  const rootNodes: TreeNode[] = [];
  const nodeMap = new Map<string, TreeNode>();

  const sortedEntries = [...entries].sort((a, b) => {
    const depthA = a.path.split('/').length;
    const depthB = b.path.split('/').length;
    if (depthA !== depthB) {
      return depthA - depthB;
    }

    if (a.is_directory !== b.is_directory) {
      return a.is_directory ? -1 : 1;
    }

    return a.path.localeCompare(b.path);
  });

  for (const entry of sortedEntries) {
    const parts = entry.path.split('/').filter(Boolean);

    for (let index = 0; index < parts.length; index += 1) {
      const currentPath = parts.slice(0, index + 1).join('/');
      if (nodeMap.has(currentPath)) {
        continue;
      }

      const isLeaf = index === parts.length - 1;
      const isDirectory = isLeaf ? entry.is_directory : true;
      const node: TreeNode = {
        id: currentPath,
        name: parts[index],
        path: currentPath,
        type: isDirectory ? 'folder' : 'file',
        children: isDirectory ? [] : undefined,
      };

      nodeMap.set(currentPath, node);

      if (index === 0) {
        rootNodes.push(node);
        continue;
      }

      const parentPath = parts.slice(0, index).join('/');
      const parentNode = nodeMap.get(parentPath);
      if (parentNode?.children) {
        parentNode.children.push(node);
      }
    }
  }

  return sortTree(rootNodes);
}

function sortTree(nodes: TreeNode[]): TreeNode[] {
  return [...nodes]
    .map((node) => ({
      ...node,
      children: node.children ? sortTree(node.children) : undefined,
    }))
    .sort((left, right) => {
      if (left.type !== right.type) {
        return left.type === 'folder' ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    });
}
