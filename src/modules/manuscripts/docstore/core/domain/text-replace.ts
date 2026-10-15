/**
 * docstore/core/domain/text-replace.ts
 *
 * Pure search/replace rules shared by project-wide replace endpoints.
 */

export interface ReplaceOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
}

export function buildSearchRegex(
  query: string,
  opts: ReplaceOptions = {},
): RegExp {
  if (!query) throw new Error('Search query must not be empty');
  let source = opts.useRegex
    ? query
    : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (opts.wholeWord) source = `\\b(?:${source})\\b`;
  const flags = opts.caseSensitive ? 'gm' : 'gim';
  const re = new RegExp(source, flags); // throws SyntaxError for invalid user regex
  if (re.test('')) {
    throw new Error('Search pattern must not match the empty string');
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
  // Literal mode must not interpret `$1`/`$&` in the replacement string.
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
