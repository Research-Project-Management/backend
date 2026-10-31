/**
 * modules/manuscripts/structure/core/domain/node-path.vo.ts
 * Value Object for Virtual Paths & Names in the Manuscript File Tree.
 */

import { InvalidNodeNameError } from './structure-errors';

export const MAX_VIRTUAL_TREE_DEPTH = 32;

export interface ParsedFolderSegment {
  readonly name: string;
  readonly path: string;
  readonly depth: number;
}

export interface ParsedNodePath {
  readonly normalizedPath: string;
  readonly relativePath: string;
  readonly leafName: string;
  readonly parentPath: string;
  readonly segments: readonly string[];
  readonly folderSegments: readonly string[];
  readonly folderChain: readonly ParsedFolderSegment[];
  readonly depth: number;
}

export class NodePathVo {
  /**
   * Normalizes virtual path:
   * - Replaces backslashes with forward slashes
   * - Ensures leading slash '/'
   * - Eliminates double slashes '//'
   * - Removes trailing slashes unless root '/'
   */
  public static normalize(p: string): string {
    if (!p || p.trim() === '' || p === '/') {
      return '/';
    }

    const rawSegments = p.replace(/\\/g, '/').trim().split('/');
    const cleanSegments: string[] = [];

    for (const seg of rawSegments) {
      if (!seg || seg === '.') continue;
      if (seg === '..') {
        throw new InvalidNodeNameError(
          '..',
          'Path traversal segment ".." is not allowed',
        );
      }
      cleanSegments.push(seg);
    }

    if (cleanSegments.length === 0) {
      return '/';
    }
    if (cleanSegments.length > MAX_VIRTUAL_TREE_DEPTH) {
      throw new InvalidNodeNameError(
        p,
        `Path exceeds maximum folder depth (${MAX_VIRTUAL_TREE_DEPTH})`,
      );
    }
    return '/' + cleanSegments.join('/');
  }

  /**
   * Single-pass canonical path parser that validates every segment and precomputes
   * normalizedPath, relativePath, leafName, parentPath, depth, and folderChain.
   */
  public static parse(rawPath: string, fallbackLeaf = ''): ParsedNodePath {
    const candidate = rawPath && rawPath.trim() !== '' ? rawPath : fallbackLeaf;
    const normalizedPath = NodePathVo.normalize(candidate);
    if (normalizedPath === '/') {
      if (fallbackLeaf) {
        NodePathVo.validateFilename(fallbackLeaf);
        return {
          normalizedPath: `/${fallbackLeaf}`,
          relativePath: fallbackLeaf,
          leafName: fallbackLeaf,
          parentPath: '/',
          segments: [fallbackLeaf],
          folderSegments: [],
          folderChain: [],
          depth: 1,
        };
      }
      return {
        normalizedPath: '/',
        relativePath: '',
        leafName: '',
        parentPath: '/',
        segments: [],
        folderSegments: [],
        folderChain: [],
        depth: 0,
      };
    }

    const segments = normalizedPath.slice(1).split('/');
    for (const seg of segments) {
      NodePathVo.validateFilename(seg);
    }

    const leafName = segments[segments.length - 1];
    const folderSegments = segments.slice(0, -1);
    const parentPath =
      folderSegments.length > 0 ? '/' + folderSegments.join('/') : '/';

    const folderChain: ParsedFolderSegment[] = [];
    let currentFolderPath = '';
    for (let i = 0; i < folderSegments.length; i++) {
      const folderName = folderSegments[i];
      currentFolderPath = `${currentFolderPath}/${folderName}`;
      folderChain.push({
        name: folderName,
        path: currentFolderPath,
        depth: i + 1,
      });
    }

    return {
      normalizedPath,
      relativePath: normalizedPath.slice(1),
      leafName,
      parentPath,
      segments,
      folderSegments,
      folderChain,
      depth: segments.length,
    };
  }

  /**
   * Converts a virtual path (e.g. `/chapters/intro.tex` or `./chapters/intro.tex`)
   * into a clean relative path without leading slashes (`chapters/intro.tex`).
   */
  public static toRelative(p: string): string {
    const norm = NodePathVo.normalize(p);
    return norm === '/' ? '' : norm.slice(1);
  }

  /**
   * Appends a suffix before the file extension (e.g. `intro.tex` + ` (Restored)` -> `intro (Restored).tex`).
   */
  public static withSuffixBeforeExt(leafName: string, suffix: string): string {
    const extIdx = leafName.lastIndexOf('.');
    const stem = extIdx > 0 ? leafName.slice(0, extIdx) : leafName;
    const ext = extIdx > 0 ? leafName.slice(extIdx) : '';
    return `${stem}${suffix}${ext}`;
  }

  /**
   * Rebases a descendant path from `sourcePrefixPath` onto `destPrefixPath`.
   */
  public static rebase(
    childPath: string,
    sourcePrefixPath: string,
    destPrefixPath: string,
  ): { path: string; depth: number; relativePath: string } {
    const normChild = NodePathVo.normalize(childPath);
    const normSource = NodePathVo.normalize(sourcePrefixPath);
    const normDest = NodePathVo.normalize(destPrefixPath);
    const suffix =
      normChild === normSource ? '' : normChild.substring(normSource.length);
    const rebased = NodePathVo.normalize(normDest + suffix);
    return {
      path: rebased,
      depth: NodePathVo.depth(rebased),
      relativePath: NodePathVo.toRelative(rebased),
    };
  }

  public static basename(p: string): string {
    const norm = NodePathVo.normalize(p);
    if (norm === '/') return '';
    const idx = norm.lastIndexOf('/');
    return norm.substring(idx + 1);
  }

  public static dirname(p: string): string {
    const norm = NodePathVo.normalize(p);
    if (norm === '/') return '/';
    const idx = norm.lastIndexOf('/');
    if (idx === 0) return '/';
    return norm.substring(0, idx);
  }

  public static depth(p: string): number {
    const norm = NodePathVo.normalize(p);
    if (norm === '/') return 0;
    return norm.split('/').filter(Boolean).length;
  }

  public static join(base: string, ...segments: string[]): string {
    const parts = [base, ...segments].filter(Boolean);
    return NodePathVo.normalize(parts.join('/'));
  }

  /**
   * Returns true if child is a strict descendant of parent.
   */
  public static isDescendant(parentPath: string, childPath: string): boolean {
    const parent = NodePathVo.normalize(parentPath);
    const child = NodePathVo.normalize(childPath);

    if (parent === '/') {
      return child !== '/';
    }
    return child.startsWith(parent + '/');
  }

  /**
   * Validates leaf filename (cannot contain '/', '\0', or be empty/reserved).
   */
  public static validateFilename(name: string): void {
    if (!name || name.trim() === '') {
      throw new InvalidNodeNameError(name, 'Name cannot be empty');
    }
    if (name.includes('/') || name.includes('\\')) {
      throw new InvalidNodeNameError(
        name,
        'Name cannot contain path separators',
      );
    }
    if (name.indexOf('\u0000') !== -1) {
      throw new InvalidNodeNameError(name, 'Name cannot contain null bytes');
    }
    if (name === '.' || name === '..') {
      throw new InvalidNodeNameError(
        name,
        'Name cannot be relative navigation tokens',
      );
    }
    if (name.length > 255) {
      throw new InvalidNodeNameError(
        name,
        'Name exceeds maximum 255 characters',
      );
    }
  }
}
