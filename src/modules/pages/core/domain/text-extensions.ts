/**
 * modules/manuscripts/core/domain/text-extensions.ts
 * Canonical text and binary file extension sets and classification helpers
 * shared across Export/Import, Git Bridge, and Linked Files.
 */

/**
 * Known editable text extensions (without leading dot).
 */
export const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  'tex',
  'ltx',
  'bib',
  'bst',
  'cls',
  'sty',
  'def',
  'cfg',
  'clo',
  'fd',
  'bbx',
  'cbx',
  'lbx',
  'dbx',
  'ist',
  'glo',
  'gls',
  'acr',
  'alg',
  'Rtex',
  'rnw',
  'knw',
  'tikz',
  'pgf',
  'asy',
  'mp',
  'txt',
  'md',
  'markdown',
  'rst',
  'csv',
  'tsv',
  'dat',
  'json',
  'yml',
  'yaml',
  'toml',
  'ini',
  'xml',
  'html',
  'htm',
  'css',
  'svg',
  'sh',
  'py',
  'r',
  'lua',
  'pl',
  'rb',
  'js',
  'ts',
  'c',
  'cpp',
  'h',
  'hpp',
  'java',
  'sql',
  'gitignore',
  'latexmkrc',
]);

/**
 * Known editable text extensions (with leading dot, lowercase).
 */
export const KNOWN_TEXT_EXTENSIONS: ReadonlySet<string> = new Set(
  Array.from(TEXT_EXTENSIONS, (ext) => `.${ext.toLowerCase()}`),
);

/**
 * Known binary extensions (with leading dot, lowercase) stored in Filestore.
 */
export const KNOWN_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.tiff',
  '.tif',
  '.pdf',
  '.eps',
  '.ps',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.ttf',
  '.otf',
  '.woff',
  '.woff2',
  '.eot',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.bin',
  '.so',
  '.dll',
  '.dylib',
  '.exe',
]);

/**
 * Checks whether a file path or filename has a known text extension (case-insensitive).
 */
export function hasTextExtension(filePath: string): boolean {
  const base = filePath.split('/').pop() ?? filePath;
  if (base === '.latexmkrc' || base === 'latexmkrc' || base === 'Makefile') {
    return true;
  }
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx < 0) return false;
  const ext = base.slice(dotIdx + 1);
  return TEXT_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext.toLowerCase());
}

/**
 * Determines whether a file path + optional buffer represents a text document
 * (no NUL bytes and has a known text extension).
 */
export function isTextPath(relPath: string, sample?: Buffer): boolean {
  if (sample && sample.includes(0)) return false;
  return hasTextExtension(relPath);
}
