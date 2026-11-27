/**
 * modules/pages/export-import/domain/latex-export.domain.ts
 *
 * Pure in-process domain functions for resolving LaTeX child document macros
 * (\input, \include, \subfile) and transpiling LaTeX into Markdown, HTML, DOCX, or TeX.
 * Zero framework or I/O dependencies.
 */

import * as path from 'path';
import { escapeLatex } from '@/modules/pages/core/domain/latex-escape';
import {
  buildZipBuffer,
  type ZipEntry,
} from '@/modules/pages/core/utils/zip-builder';

export { escapeLatex };

export function sanitizeLatexUrl(url: string): string {
  return (url || '').replace(/[{}\\%#\r\n\0]/g, '').trim();
}

export function unescapeXml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface IncludedProjectDoc {
  id: string;
  path: string;
  lines: unknown;
}

export interface ExportFormattedDocResult {
  filename: string;
  mimeType: string;
  content: string;
  isBase64: boolean;
  sizeBytes: number;
}

export function convertLatexToMarkdown(
  latex: string,
  fallbackTitle?: string,
): string {
  let content = latex.replace(/\r\n/g, '\n');
  content = content.replace(/(^|[^\\])%.*$/gm, '$1');

  const titleMatch = content.match(/\\title\{([^}]+)\}/);
  const title = titleMatch ? titleMatch[1].trim() : fallbackTitle || '';

  const docMatch = content.match(
    /\\begin\{document\}([\s\S]*?)\\end\{document\}/,
  );
  if (docMatch) {
    content = docMatch[1];
  } else {
    content = content.replace(/[\s\S]*?\\begin\{document\}/, '');
  }

  content = content
    .replace(/\\maketitle/g, title ? `# ${title}\n` : '')
    .replace(/\\tableofcontents/g, '')
    .replace(/\\newpage/g, '\n---\n')
    .replace(/\\clearpage/g, '\n---\n')
    .replace(/\\section\*?\{([^}]+)\}/g, '\n# $1\n')
    .replace(/\\subsection\*?\{([^}]+)\}/g, '\n## $1\n')
    .replace(/\\subsubsection\*?\{([^}]+)\}/g, '\n### $1\n')
    .replace(/\\paragraph\*?\{([^}]+)\}/g, '\n#### $1\n')
    .replace(/\\textbf\{([^}]+)\}/g, '**$1**')
    .replace(/\\textit\{([^}]+)\}/g, '*$1*')
    .replace(/\\emph\{([^}]+)\}/g, '*$1*')
    .replace(/\\underline\{([^}]+)\}/g, '<u>$1</u>')
    .replace(/\\texttt\{([^}]+)\}/g, '`$1`')
    .replace(
      /\\begin\{verbatim\}([\s\S]*?)\\end\{verbatim\}/g,
      '\n```\n$1\n```\n',
    )
    .replace(/\\begin\{itemize\}/g, '')
    .replace(/\\end\{itemize\}/g, '')
    .replace(/\\begin\{enumerate\}/g, '')
    .replace(/\\end\{enumerate\}/g, '')
    .replace(/\\item\s*/g, '\n- ')
    .replace(/\\href\{([^}]+)\}\{([^}]+)\}/g, '[$2]($1)')
    .replace(/\\url\{([^}]+)\}/g, '<$1>')
    .replace(/\\cite\{([^}]+)\}/g, '[$1]')
    .replace(/\\ref\{([^}]+)\}/g, '$1')
    .replace(/\\label\{([^}]+)\}/g, '')
    .replace(/\\\\/g, '\n');

  return content.trim();
}

export function convertLatexToHtml(latex: string, title?: string): string {
  const md = convertLatexToMarkdown(latex, title);
  const docTitle = title || 'Document';

  const formatInlineHtml = (text: string): string =>
    escapeXml(text)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  const paragraphs = md
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('# '))
        return `<h1>${formatInlineHtml(trimmed.slice(2))}</h1>`;
      if (trimmed.startsWith('## '))
        return `<h2>${formatInlineHtml(trimmed.slice(3))}</h2>`;
      if (trimmed.startsWith('### '))
        return `<h3>${formatInlineHtml(trimmed.slice(4))}</h3>`;
      if (trimmed.startsWith('#### '))
        return `<h4>${formatInlineHtml(trimmed.slice(5))}</h4>`;
      if (trimmed.startsWith('- ')) {
        const items = trimmed
          .split('\n')
          .map((line) => line.replace(/^-\s*/, '').trim())
          .filter(Boolean)
          .map((item) => `<li>${formatInlineHtml(item)}</li>`)
          .join('');
        return `<ul>${items}</ul>`;
      }
      return `<p>${formatInlineHtml(trimmed).replace(/\n/g, '<br/>')}</p>`;
    })
    .filter(Boolean)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeXml(docTitle)}</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      max-width: 840px;
      margin: 40px auto;
      padding: 0 24px;
      color: #1a202c;
    }
    h1, h2, h3, h4 { color: #0f172a; margin-top: 1.5em; margin-bottom: 0.5em; }
    p { margin-bottom: 1em; }
    ul { margin: 1em 0; padding-left: 24px; }
    li { margin-bottom: 0.5em; }
    code { background: #f1f5f9; padding: 2px 5px; border-radius: 4px; font-size: 0.9em; }
  </style>
</head>
<body>
  ${paragraphs}
</body>
</html>`;
}

export function buildMinimalZip(entries: ZipEntry[]): Buffer {
  return buildZipBuffer(entries);
}

export function convertLatexToDocxBuffer(
  latex: string,
  title?: string,
): Buffer {
  const md = convertLatexToMarkdown(latex, title);
  const pNodes: string[] = [];

  for (const line of md.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      pNodes.push('<w:p/>');
      continue;
    }

    if (trimmed.startsWith('# ')) {
      pNodes.push(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="36"/></w:rPr><w:t>${escapeXml(trimmed.slice(2))}</w:t></w:r></w:p>`);
    } else if (trimmed.startsWith('## ')) {
      pNodes.push(`<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr><w:t>${escapeXml(trimmed.slice(3))}</w:t></w:r></w:p>`);
    } else if (trimmed.startsWith('### ')) {
      pNodes.push(`<w:p><w:pPr><w:pStyle w:val="Heading3"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="24"/></w:rPr><w:t>${escapeXml(trimmed.slice(4))}</w:t></w:r></w:p>`);
    } else {
      pNodes.push(`<w:p><w:r><w:t xml:space="preserve">${escapeXml(trimmed)}</w:t></w:r></w:p>`);
    }
  }

  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${pNodes.join('\n')}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

  const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

  const wordRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

  return buildMinimalZip([
    { path: '[Content_Types].xml', data: Buffer.from(contentTypesXml, 'utf8') },
    { path: '_rels/.rels', data: Buffer.from(rootRelsXml, 'utf8') },
    { path: 'word/_rels/document.xml.rels', data: Buffer.from(wordRelsXml, 'utf8') },
    { path: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ]);
}

const INCLUDE_MACRO_RE = /\\(input|include|subfile)\s*\{([^}]+)\}/g;

interface LazyDocNode {
  rawLines: unknown;
  cachedText?: string;
}

function readLazyDocText(node: LazyDocNode): string {
  if (node.cachedText !== undefined) return node.cachedText;
  node.cachedText = Array.isArray(node.rawLines)
    ? (node.rawLines as string[]).join('\n')
    : typeof node.rawLines === 'string'
      ? node.rawLines
      : '';
  return node.cachedText;
}

function buildLazyDocIndex(
  projectDocs: ReadonlyArray<{ id: string; path: string; lines: unknown }>,
): Map<string, LazyDocNode> {
  const index = new Map<string, LazyDocNode>();
  for (let i = 0; i < projectDocs.length; i++) {
    const d = projectDocs[i];
    const cleanPath = (d.path || '').replace(/^\/+/, '').trim();
    if (!cleanPath) continue;

    const lazyNode: LazyDocNode = { rawLines: d.lines };
    index.set(cleanPath, lazyNode);
    index.set(cleanPath.toLowerCase(), lazyNode);

    const withoutExt = cleanPath.replace(/\.tex$/i, '');
    if (!index.has(withoutExt)) {
      index.set(withoutExt, lazyNode);
      index.set(withoutExt.toLowerCase(), lazyNode);
    }

    const baseOnly = path.posix.basename(cleanPath);
    if (!index.has(baseOnly)) {
      index.set(baseOnly, lazyNode);
      index.set(baseOnly.toLowerCase(), lazyNode);
    }

    const baseWithoutExt = baseOnly.replace(/\.tex$/i, '');
    if (!index.has(baseWithoutExt)) {
      index.set(baseWithoutExt, lazyNode);
      index.set(baseWithoutExt.toLowerCase(), lazyNode);
    }
  }
  return index;
}

function expandIncludesWithIndex(
  content: string,
  docIndex: Map<string, LazyDocNode>,
  visited: Set<string>,
  depth: number,
): string {
  if (depth > 8) return content;

  return content.replace(
    INCLUDE_MACRO_RE,
    (fullMatch, macro: string, rawTarget: string) => {
      const target = rawTarget.trim().replace(/^\/+/, '').replace(/^\.\//, '');
      const lowerTarget = target.toLowerCase();
      if (!target || visited.has(lowerTarget)) {
        return fullMatch;
      }

      const matchedNode =
        docIndex.get(target) ??
        docIndex.get(`${target}.tex`) ??
        docIndex.get(lowerTarget) ??
        docIndex.get(`${lowerTarget}.tex`);

      if (!matchedNode) {
        return fullMatch;
      }

      const nextVisited = new Set(visited);
      nextVisited.add(lowerTarget);
      const resolvedChild = expandIncludesWithIndex(
        readLazyDocText(matchedNode),
        docIndex,
        nextVisited,
        depth + 1,
      );

      return macro === 'include'
        ? `\n\\clearpage\n${resolvedChild}\n\\clearpage\n`
        : resolvedChild;
    },
  );
}

/**
 * O(N + L_referenced) single-index recursive macro expansion with memoized line joining.
 */
export function resolveIncludedLatexContent(
  rootContent: string,
  projectDocs: ReadonlyArray<{ id: string; path: string; lines: unknown }>,
  visited = new Set<string>(),
  depth = 0,
): string {
  if (depth > 8 || projectDocs.length === 0) return rootContent;
  const docIndex = buildLazyDocIndex(projectDocs);
  return expandIncludesWithIndex(rootContent, docIndex, visited, depth);
}

interface ExportFormatterInput {
  rawFilename: string;
  baseName: string;
  content: string;
}

type ExportFormatter = (ctx: ExportFormatterInput) => ExportFormattedDocResult;

const EXPORT_TEX: ExportFormatter = (ctx) => ({
  filename: ctx.rawFilename,
  mimeType: 'application/x-tex',
  content: ctx.content,
  isBase64: false,
  sizeBytes: Buffer.byteLength(ctx.content, 'utf8'),
});

const EXPORT_MD: ExportFormatter = (ctx) => {
  const mdContent = convertLatexToMarkdown(ctx.content, ctx.baseName);
  return {
    filename: `${ctx.baseName}.md`,
    mimeType: 'text/markdown',
    content: mdContent,
    isBase64: false,
    sizeBytes: Buffer.byteLength(mdContent, 'utf8'),
  };
};

const EXPORT_HTML: ExportFormatter = (ctx) => {
  const htmlContent = convertLatexToHtml(ctx.content, ctx.baseName);
  return {
    filename: `${ctx.baseName}.html`,
    mimeType: 'text/html',
    content: htmlContent,
    isBase64: false,
    sizeBytes: Buffer.byteLength(htmlContent, 'utf8'),
  };
};

const EXPORT_DOCX: ExportFormatter = (ctx) => {
  const docxBuffer = convertLatexToDocxBuffer(ctx.content, ctx.baseName);
  return {
    filename: `${ctx.baseName}.docx`,
    mimeType:
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    content: docxBuffer.toString('base64'),
    isBase64: true,
    sizeBytes: docxBuffer.length,
  };
};

const EXPORT_FORMATTERS: Record<string, ExportFormatter> = {
  tex: EXPORT_TEX,
  latex: EXPORT_TEX,
  md: EXPORT_MD,
  markdown: EXPORT_MD,
  html: EXPORT_HTML,
  docx: EXPORT_DOCX,
};

export function transpileLatexDocument(params: {
  rawFilename: string;
  content: string;
  format: string;
  projectDocs?: IncludedProjectDoc[];
}): ExportFormattedDocResult {
  const rawFilename = params.rawFilename || 'document.tex';
  const baseName = rawFilename.replace(/\.[^/.]+$/, '');
  let content = params.content;

  if (params.projectDocs && params.projectDocs.length > 0) {
    const rootKey = rawFilename.toLowerCase();
    content = resolveIncludedLatexContent(
      content,
      params.projectDocs,
      new Set([rootKey, rootKey.replace(/\.tex$/i, '')]),
    );
  }

  const key = (params.format || 'tex').trim().toLowerCase();
  const formatter = EXPORT_FORMATTERS[key] ?? EXPORT_TEX;
  return formatter({ rawFilename, baseName, content });
}
