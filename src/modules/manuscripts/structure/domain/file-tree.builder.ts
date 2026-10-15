/**
 * structure/domain/file-tree.builder.ts
 * Pure, side-effect-free domain functions for building hierarchical file trees,
 * detecting root compilation documents (Overleaf _rootDocSort), and validating path rules.
 */

import { ManuscriptNodeEntity } from './manuscript-node.entity';
import { NodePathVo } from './node-path.vo';
import {
  CannotDeleteRootFolderError,
  CyclicMoveError,
  MaxProjectFilesExceededError,
} from './structure-errors';
import { TreeNodeDto } from '../dto/node.dto';

const VALID_ROOT_EXTENSIONS = ['.tex', '.rtex', '.rnw'];
export const DEFAULT_MAX_PROJECT_FILES = 2000;

export class FileTreeBuilder {
  /**
   * Transforms flat ManuscriptNodeEntity[] into a sorted recursive TreeNodeDto[] hierarchy.
   * Folders are sorted before files; root docs prioritized; then sortOrder, then alphabetical.
   */
  public static buildTreeHierarchy(
    nodes: readonly ManuscriptNodeEntity[],
  ): TreeNodeDto[] {
    const nodeMap = new Map<string, TreeNodeDto>();
    const rootNodes: TreeNodeDto[] = [];

    for (const node of nodes) {
      nodeMap.set(node.id, {
        id: node.id,
        name: node.name,
        path: node.path,
        type: node.type,
        depth: node.depth,
        isRootDoc: node.isRootDoc,
        docId: node.docId,
        fileId: node.fileId,
        sizeBytes: node.sizeBytes,
        hash: node.hash,
        sortOrder: node.sortOrder,
        children: [],
      });
    }

    for (const node of nodes) {
      const treeNode = nodeMap.get(node.id)!;
      if (node.parentId && nodeMap.has(node.parentId)) {
        nodeMap.get(node.parentId)!.children.push(treeNode);
      } else {
        rootNodes.push(treeNode);
      }
    }

    const sortFn = (a: TreeNodeDto, b: TreeNodeDto): number => {
      if (a.type === 'FOLDER' && b.type !== 'FOLDER') return -1;
      if (a.type !== 'FOLDER' && b.type === 'FOLDER') return 1;
      if (a.isRootDoc && !b.isRootDoc) return -1;
      if (!a.isRootDoc && b.isRootDoc) return 1;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.name.localeCompare(b.name);
    };

    const sortRecursively = (list: TreeNodeDto[]) => {
      list.sort(sortFn);
      for (const item of list) {
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
    const candidates = nodes.filter((n) => {
      if (!n.isDoc()) return false;
      const lowerName = n.name.toLowerCase();
      return VALID_ROOT_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
    });

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
    return virtualPath
      .trim()
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/^\/+/, '');
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
    if (node.path === '/') {
      throw new CannotDeleteRootFolderError();
    }
    if (
      node.isFolder() &&
      (destPath === node.path || NodePathVo.isDescendant(node.path, destPath))
    ) {
      throw new CyclicMoveError(node.path, destPath);
    }
  }
}
