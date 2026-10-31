/**
 * modules/manuscripts/core/domain/latex-escape.ts
 * Canonical LaTeX character escaping utility shared across Citations, Docstore, and Export/Import.
 */

export function escapeLatex(text: string): string {
  if (!text) return '';
  return text.replace(/([\\{}$&#%_^~])/g, (char) => {
    switch (char) {
      case '\\':
        return '\\textbackslash{}';
      case '{':
        return '\\{';
      case '}':
        return '\\}';
      case '$':
        return '\\$';
      case '&':
        return '\\&';
      case '#':
        return '\\#';
      case '%':
        return '\\%';
      case '_':
        return '\\_';
      case '^':
        return '\\textasciicircum{}';
      case '~':
        return '\\textasciitilde{}';
      default:
        return char;
    }
  });
}
