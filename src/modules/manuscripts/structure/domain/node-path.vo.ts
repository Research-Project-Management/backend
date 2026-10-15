/**
 * modules/manuscripts/structure/core/domain/node-path.vo.ts
 * Value Object for Virtual Paths & Names in the Manuscript File Tree.
 */

import { InvalidNodeNameError } from './structure-errors';

export class NodePathVo {
  private readonly _path: string;

  private constructor(rawPath: string) {
    this._path = NodePathVo.normalize(rawPath);
  }

  public static of(rawPath: string): NodePathVo {
    return new NodePathVo(rawPath);
  }

  public get value(): string {
    return this._path;
  }

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
    return '/' + cleanSegments.join('/');
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
