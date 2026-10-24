/**
 * modules/manuscripts/export-import/domain/latex-export-transpiler.ts
 * Pure in-process domain functions for resolving LaTeX child document macros
 * (\input, \include, \subfile) and transpiling LaTeX into Markdown, HTML, and DOCX buffers.
 */

import * as path from 'path';
import { escapeLatex } from '@/modules/manuscripts/core';
import {
  buildPkZipBuffer,
  type PkZipEntry,
} from '@/modules/manuscripts/core/utils/pkzip-builder.util';

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

/**
 * Pure XML character escaping for HTML titles and WordprocessingML nodes.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Pure transpilation of a LaTeX source document into Markdown.
 */
export function convertLatexToMarkdown(
  latex: string,
  fallbackTitle?: string,
): string {
  let content = latex.replace(/\r\n/g, '\n');

  // Strip LaTeX comments
  content = content.replace(/(^|[^\\])%.*$/gm, '$1');

  // Extract title if present
  const titleMatch = content.match(/\\title\{([^}]+)\}/);
  const title = titleMatch ? titleMatch[1].trim() : fallbackTitle || '';

  // Extract body between \begin{document} and \end{document} if present
  const docMatch = content.match(
    /\\begin\{document\}([\s\S]*?)\\end\{document\}/,
  );
  if (docMatch) {
    content = docMatch[1];
  } else {
    content = content.replace(/[\s\S]*?\\begin\{document\}/, '');
  }

  // Remove common commands and convert structure
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

/**
 * Pure transpilation of a LaTeX source document into a standalone HTML5 document.
 */
export function convertLatexToHtml(latex: string, title?: string): string {
  const md = convertLatexToMarkdown(latex, title);
  const docTitle = title || 'Document';

  const paragraphs = md
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return '';
      if (trimmed.startsWith('# ')) return `<h1>${trimmed.slice(2)}</h1>`;
      if (trimmed.startsWith('## ')) return `<h2>${trimmed.slice(3)}</h2>`;
      if (trimmed.startsWith('### ')) return `<h3>${trimmed.slice(4)}</h3>`;
      if (trimmed.startsWith('#### ')) return `<h4>${trimmed.slice(5)}</h4>`;
      if (trimmed.startsWith('- ')) {
        const items = trimmed
          .split('\n')
          .map((line) => line.replace(/^-\s*/, '').trim())
          .filter(Boolean)
          .map((item) => `<li>${item}</li>`)
          .join('');
        return `<ul>${items}</ul>`;
      }
      return `<p>${trimmed.replace(/\n/g, '<br/>')}</p>`;
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

/**
 * Builds an in-memory PKZIP buffer from raw zip entries.
 */
export function buildMinimalZip(entries: PkZipEntry[]): Buffer {
  return buildPkZipBuffer(entries);
}

/**
 * Pure transpilation of a LaTeX source document into an OpenXML (.docx) binary Buffer.
 */
export function convertLatexToDocxBuffer(
  latex: string,
  title?: string,
): Buffer {
  const md = convertLatexToMarkdown(latex, title);
  const lines = md.split('\n');

  const pNodes: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      pNodes.push('<w:p/>');
      continue;
    }

    if (trimmed.startsWith('# ')) {
      const headingText = escapeXml(trimmed.slice(2));
      pNodes.push(`
        <w:p>
          <w:pPr>
            <w:pStyle w:val="Heading1"/>
          </w:pPr>
          <w:r>
            <w:rPr>
              <w:b/>
              <w:sz w:val="36"/>
            </w:rPr>
            <w:t>${headingText}</w:t>
          </w:r>
        </w:p>
      `);
    } else if (trimmed.startsWith('## ')) {
      const headingText = escapeXml(trimmed.slice(3));
      pNodes.push(`
        <w:p>
          <w:pPr>
            <w:pStyle w:val="Heading2"/>
          </w:pPr>
          <w:r>
            <w:rPr>
              <w:b/>
              <w:sz w:val="28"/>
            </w:rPr>
            <w:t>${headingText}</w:t>
          </w:r>
        </w:p>
      `);
    } else if (trimmed.startsWith('### ')) {
      const headingText = escapeXml(trimmed.slice(4));
      pNodes.push(`
        <w:p>
          <w:pPr>
            <w:pStyle w:val="Heading3"/>
          </w:pPr>
          <w:r>
            <w:rPr>
              <w:b/>
              <w:sz w:val="24"/>
            </w:rPr>
            <w:t>${headingText}</w:t>
          </w:r>
        </w:p>
      `);
    } else {
      const escapedText = escapeXml(trimmed);
      pNodes.push(`
        <w:p>
          <w:r>
            <w:t xml:space="preserve">${escapedText}</w:t>
          </w:r>
        </w:p>
      `);
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
    {
      path: 'word/_rels/document.xml.rels',
      data: Buffer.from(wordRelsXml, 'utf8'),
    },
    { path: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ]);
}

/**
 * Pure computation that resolves `\input{...}`, `\include{...}`, and `\subfile{...}` macros
 * against project documents so multi-file manuscripts export complete content.
 */
export function resolveIncludedLatexContent(
  rootContent: string,
  projectDocs: ReadonlyArray<{ id: string; path: string; lines: unknown }>,
  visited = new Set<string>(),
  depth = 0,
): string {
  if (depth > 8) return rootContent;

  const docByPath = new Map<string, string>();
  for (const d of projectDocs) {
    const cleanPath = (d.path || '').replace(/^\/+/, '').trim();
    if (!cleanPath) continue;
    const text = Array.isArray(d.lines)
      ? (d.lines as string[]).join('\n')
      : typeof d.lines === 'string'
        ? d.lines
        : '';
    docByPath.set(cleanPath, text);
    docByPath.set(cleanPath.toLowerCase(), text);
    const withoutExt = cleanPath.replace(/\.tex$/i, '');
    if (!docByPath.has(withoutExt)) {
      docByPath.set(withoutExt, text);
      docByPath.set(withoutExt.toLowerCase(), text);
    }
    const baseOnly = path.posix.basename(cleanPath);
    if (!docByPath.has(baseOnly)) {
      docByPath.set(baseOnly, text);
      docByPath.set(baseOnly.toLowerCase(), text);
    }
    const baseWithoutExt = baseOnly.replace(/\.tex$/i, '');
    if (!docByPath.has(baseWithoutExt)) {
      docByPath.set(baseWithoutExt, text);
      docByPath.set(baseWithoutExt.toLowerCase(), text);
    }
  }

  return rootContent.replace(
    /\\(input|include|subfile)\s*\{([^}]+)\}/g,
    (fullMatch, macro: string, rawTarget: string) => {
      const target = rawTarget.trim().replace(/^\/+/, '').replace(/^\.\//, '');
      if (!target || visited.has(target.toLowerCase())) {
        return fullMatch;
      }

      const childText =
        docByPath.get(target) ??
        docByPath.get(`${target}.tex`) ??
        docByPath.get(target.toLowerCase()) ??
        docByPath.get(`${target.toLowerCase()}.tex`);

      if (childText === undefined) {
        return fullMatch;
      }

      const nextVisited = new Set(visited);
      nextVisited.add(target.toLowerCase());
      const resolvedChild = resolveIncludedLatexContent(
        childText,
        projectDocs,
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
 * Pure transpilation of a LaTeX document (with optional child document resolution)
 * into the requested export format (tex, md, html, docx).
 */
export function transpileLatexDocumentForExport(params: {
  rawFilename: string;
  content: string;
  format: string;
  projectDocs?: IncludedProjectDoc[];
}): ExportFormattedDocResult {
  const format = (params.format || 'tex').toLowerCase();
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

  if (format === 'docx') {
    const docxBuffer = convertLatexToDocxBuffer(content, baseName);
    return {
      filename: `${baseName}.docx`,
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: docxBuffer.toString('base64'),
      isBase64: true,
      sizeBytes: docxBuffer.length,
    };
  }

  if (format === 'md' || format === 'markdown') {
    const mdContent = convertLatexToMarkdown(content, baseName);
    return {
      filename: `${baseName}.md`,
      mimeType: 'text/markdown',
      content: mdContent,
      isBase64: false,
      sizeBytes: Buffer.byteLength(mdContent, 'utf8'),
    };
  }

  if (format === 'html') {
    const htmlContent = convertLatexToHtml(content, baseName);
    return {
      filename: `${baseName}.html`,
      mimeType: 'text/html',
      content: htmlContent,
      isBase64: false,
      sizeBytes: Buffer.byteLength(htmlContent, 'utf8'),
    };
  }

  return {
    filename: rawFilename,
    mimeType: 'application/x-tex',
    content,
    isBase64: false,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
  };
}

export const LatexExportTranspiler = {
  escapeXml,
  convertLatexToMarkdown,
  convertLatexToHtml,
  buildMinimalZip,
  convertLatexToDocxBuffer,
  resolveIncludedLatexContent,
  transpileLatexDocumentForExport,
} as const;
