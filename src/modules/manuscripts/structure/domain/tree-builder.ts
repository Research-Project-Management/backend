/**
 * structure/domain/tree-builder.ts
 * Pure, side-effect-free domain functions for building hierarchical file trees,
 * detecting root compilation documents (Overleaf _rootDocSort), and validating path rules.
 */

import {
  ManuscriptNodeEntity,
  SerializedTreeNode,
} from './node.entity';
import { NodePathVo } from './node-path';
import { MaxProjectFilesExceededError } from './structure.errors';

export type TreeNode = SerializedTreeNode;

export const DEFAULT_MAX_PROJECT_FILES = 2000;

export class FileTreeBuilder {
  /**
   * Transforms flat ManuscriptNodeEntity[] into a sorted recursive TreeNode[] hierarchy.
   * Folders are sorted before files; root docs prioritized; then sortOrder, then alphabetical.
   */
  public static buildTreeHierarchy(
    nodes: readonly ManuscriptNodeEntity[],
  ): TreeNode[] {
    const nodeMap = new Map<string, TreeNode>();
    const pathToNodeMap = new Map<string, TreeNode>();
    const parentLookup = new Map<string, string | null>();
    const rootNodes: TreeNode[] = [];

    for (const node of nodes) {
      const treeNode = node.toTreeNode();
      nodeMap.set(node.id, treeNode);
      pathToNodeMap.set(node.path, treeNode);
      parentLookup.set(node.id, node.parentId ?? null);
    }

    const hasParentCycle = (startId: string, candidateParentId: string): boolean => {
      const visited = new Set<string>([startId]);
      let curr: string | null | undefined = candidateParentId;
      while (curr) {
        if (visited.has(curr)) return true;
        visited.add(curr);
        curr = parentLookup.get(curr) ?? null;
      }
      return false;
    };

    for (const node of nodes) {
      const treeNode = nodeMap.get(node.id)!;
      if (
        node.parentId &&
        nodeMap.has(node.parentId) &&
        !hasParentCycle(node.id, node.parentId)
      ) {
        nodeMap.get(node.parentId)!.children.push(treeNode);
      } else {
        // Resilient fallback: If parentId is missing or corrupt, resolve parent folder via parentPath
        const parentPath = NodePathVo.dirname(node.path);
        if (parentPath !== '/' && pathToNodeMap.has(parentPath)) {
          const parentTreeNode = pathToNodeMap.get(parentPath)!;
          if (
            parentTreeNode.type === 'FOLDER' &&
            parentTreeNode.id !== node.id &&
            !hasParentCycle(node.id, parentTreeNode.id)
          ) {
            parentTreeNode.children.push(treeNode);
            continue;
          }
        }
        rootNodes.push(treeNode);
      }
    }

    const sortFn = (a: TreeNode, b: TreeNode): number => {
      if (a.type === 'FOLDER' && b.type !== 'FOLDER') return -1;
      if (a.type !== 'FOLDER' && b.type === 'FOLDER') return 1;
      if (a.isRootDoc && !b.isRootDoc) return -1;
      if (!a.isRootDoc && b.isRootDoc) return 1;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.name.localeCompare(b.name);
    };

    const sortedVisited = new Set<string>();
    const sortRecursively = (list: TreeNode[]) => {
      list.sort(sortFn);
      for (const item of list) {
        if (sortedVisited.has(item.id)) continue;
        sortedVisited.add(item.id);
        if (item.children.length > 0) {
          sortRecursively(item.children);
        }
      }
    };

    sortRecursively(rootNodes);
    return rootNodes;
  }

  /**
   * Overleaf-grade heuristic algorithm (_rootDocSort) to automatically detect
   * the main LaTeX compilation document.
   */
  public static detectRootDoc(
    nodes: readonly ManuscriptNodeEntity[],
    docContents: Map<string, string[]>,
  ): ManuscriptNodeEntity | null {
    const candidates = nodes.filter((n) => n.canBeRootDoc());

    if (candidates.length === 0) {
      return null;
    }

    const sorted = [...candidates].sort((a, b) =>
      FileTreeBuilder.rootDocSort(a, b),
    );

    let subfileFallback: ManuscriptNodeEntity | null = null;
    for (const candidate of sorted) {
      const lines =
        docContents.get(candidate.id) ||
        (candidate.docId ? docContents.get(candidate.docId) : undefined);
      if (lines) {
        const docClass = FileTreeBuilder.extractDocumentclass(lines);
        if (docClass) {
          if (docClass.toLowerCase() !== 'subfiles') {
            return candidate;
          }
          if (!subfileFallback) {
            subfileFallback = candidate;
          }
        }
      }
    }

    if (subfileFallback) {
      return subfileFallback;
    }

    return sorted[0] || null;
  }

  /**
   * Port of Overleaf _rootDocSort:
   * 1. Depth: Folders closer to root '/' are prioritized
   * 2. Canonical name: 'main.tex' is prioritized over other filenames
   * 3. Size: Smaller files are prioritized
   * 4. Lexicographical: Alphabetical order
   */
  public static rootDocSort(
    a: ManuscriptNodeEntity,
    b: ManuscriptNodeEntity,
  ): number {
    if (a.depth !== b.depth) {
      return a.depth - b.depth;
    }

    const aLower = a.name.toLowerCase();
    const bLower = b.name.toLowerCase();
    if (aLower === 'main.tex' && bLower !== 'main.tex') return -1;
    if (aLower !== 'main.tex' && bLower === 'main.tex') return 1;

    if (a.sizeBytes !== b.sizeBytes) {
      return a.sizeBytes - b.sizeBytes;
    }

    return a.path.localeCompare(b.path);
  }

  public static extractDocumentclass(lines: readonly string[]): string | null {
    const cleanText = lines
      .map((line) => line.split(/(?<!\\)%/)[0])
      .join('\n')
      .replace(/\\iffalse\b[\s\S]*?\\fi\b/g, '');
    const match = cleanText.match(
      /\\documentclass\s*(?:\[[\s\S]*?\])?\s*\{([^}]+)\}/i,
    );
    return match && match[1] ? match[1].trim() : null;
  }

  /**
   * Converts an absolute virtual path (e.g. `/chapters/intro.tex`) to a relative
   * compiler workspace path (`chapters/intro.tex`).
   */
  public static toRelativeCompilerPath(virtualPath: string): string {
    return NodePathVo.toRelative(virtualPath);
  }

  /**
   * Validates project file count limit.
   */
  public static validateProjectFileLimit(
    currentCount: number,
    maxFiles = DEFAULT_MAX_PROJECT_FILES,
  ): void {
    if (currentCount >= maxFiles) {
      throw new MaxProjectFilesExceededError(maxFiles);
    }
  }

  /**
   * Validates that moving `node` to `destPath` does not move root `/` or create a folder cycle.
   */
  public static validateMoveTarget(
    node: ManuscriptNodeEntity,
    destPath: string,
  ): void {
    node.validateMoveTo(destPath);
  }
}

export class HeuristicRootDocDetector {
  public detectRootDoc(
    nodes: readonly ManuscriptNodeEntity[],
    docContents: Map<string, string[]>,
  ): ManuscriptNodeEntity | null {
    return FileTreeBuilder.detectRootDoc(nodes, docContents);
  }
}
