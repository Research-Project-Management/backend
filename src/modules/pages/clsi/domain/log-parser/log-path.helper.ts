/**
 * modules/pages/clsi/domain/log-parser/log-path.helper.ts
 * Pure TeX paren-cleaning and nested project relative path normalizers.
 */

export const LOG_FILE_EXTENSION_REGEX =
  /\.(tex|sty|cls|bib|bbl|aux|toc|lof|lot|out|def|ldf|fd|cfg|dtx|ins)\b/i;

export function cleanNonFileParens(line: string): string {
  if (line.length > 8192) {
    return line.slice(0, 8192);
  }
  let result = line;
  let prev = '';
  let iterations = 0;
  while (result !== prev && iterations < 8) {
    prev = result;
    iterations++;
    result = result.replace(/\(([^()]*)\)/g, (fullMatch, content: string) => {
      if (LOG_FILE_EXTENSION_REGEX.test(content)) {
        return fullMatch;
      }
      return ' ';
    });
  }
  return result;
}

export function normalizeLogFilePath(
  rawPath: string,
  defaultFile: string,
): string {
  let normalized = rawPath.replace(/\\/g, '/').replace(/^\/?compile\//, '');
  const isDrivePath = /^[a-zA-Z]:\//.test(normalized);
  normalized = normalized.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (normalized.includes('texmf') || normalized.includes('texlive')) {
    const parts = normalized.split('/');
    return parts[parts.length - 1] || defaultFile;
  }
  if (!isDrivePath && normalized) {
    const normalizedDefault = defaultFile
      .replace(/\\/g, '/')
      .replace(/^(\.\/)+/, '')
      .replace(/^\/+/, '');
    const lastSlash = normalizedDefault.lastIndexOf('/');
    if (lastSlash > 0) {
      const baseDir = normalizedDefault.slice(0, lastSlash);
      if (
        !normalized.startsWith(`${baseDir}/`) &&
        normalized !== normalizedDefault
      ) {
        return `${baseDir}/${normalized}`;
      }
    }
  }
  return normalized;
}
