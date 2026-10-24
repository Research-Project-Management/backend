/**
 * modules/manuscripts/docstore/domain/text-replace.ts
 * Pure search/replace rules shared by project-wide replace endpoints.
 */

import { InvalidSearchPatternError } from './doc-errors';

export interface ReplaceOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
}

export function buildSearchRegex(
  query: string,
  opts: ReplaceOptions = {},
): RegExp {
  if (!query) throw new InvalidSearchPatternError('Search query must not be empty');
  if (query.length > 500) throw new InvalidSearchPatternError('Search pattern exceeds maximum allowed length of 500 characters');

  if (opts.useRegex) {
    // Basic ReDoS protection: detect potentially catastrophic nested quantifiers like (a+)+ or (.*)*
    const dangerousNestedQuantifiers = /([*+]\??)\s*\)?\s*[*+]/;
    if (dangerousNestedQuantifiers.test(query)) {
      throw new InvalidSearchPatternError('Unsafe regular expression pattern with nested quantifiers');
    }
  }

  let source = opts.useRegex
    ? query
    : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.wholeWord) source = `\\b(?:${source})\\b`;
  const flags = opts.caseSensitive ? 'gm' : 'gim';
  const re = new RegExp(source, flags);
  if (re.test('')) {
    throw new InvalidSearchPatternError('Search pattern must not match the empty string');
  }
  re.lastIndex = 0;
  return re;
}

export function replaceInText(
  text: string,
  query: string,
  replaceWith: string,
  opts: ReplaceOptions = {},
): { text: string; count: number } {
  const re = buildSearchRegex(query, opts);
  let count = 0;
  const next = text.replace(re, (...args) => {
    count++;
    if (!opts.useRegex) return replaceWith;
    const hasNamed = typeof args[args.length - 1] === 'object';
    const groups = args.slice(1, hasNamed ? -3 : -2) as string[];
    return replaceWith.replace(/\$(\$|&|\d+)/g, (_m, g: string) => {
      if (g === '$') return '$';
      if (g === '&') return args[0];
      const num = Number(g);
      if (num >= 1 && num <= groups.length) {
        return groups[num - 1] ?? '';
      }
      if (g.length > 1) {
        const firstDigit = Number(g[0]);
        if (firstDigit >= 1 && firstDigit <= groups.length) {
          return (groups[firstDigit - 1] ?? '') + g.slice(1);
        }
      }
      return '';
    });
  });
  return { text: next, count };
}
