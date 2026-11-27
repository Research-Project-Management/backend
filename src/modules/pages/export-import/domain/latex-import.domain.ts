/**
 * modules/pages/export-import/domain/latex-import.domain.ts
 *
 * Pure in-process domain functions converting Markdown (.md / .markdown) and
 * extracted Word OpenXML (.docx) entries into compilable LaTeX project entries.
 * Zero framework (`@nestjs/*`) or adapter imports.
 */

import * as path from 'node:path';
import { ArchiveEntryVo } from './archive.domain';
import { InvalidZipArchiveException } from './archive.errors';
import type { TranspiledProjectResult } from '../types/archive.types';
import {
  escapeLatex,
  sanitizeLatexUrl,
  unescapeXml,
} from './latex-export.domain';

export { escapeLatex, sanitizeLatexUrl, unescapeXml };
export type { TranspiledProjectResult };

export type SupportedImportFormat = 'docx' | 'md';

export function resolveImportFormat(
  explicitFormat?: string,
  fileName?: string,
): SupportedImportFormat | null {
  const raw = explicitFormat || (fileName ? path.extname(fileName) : '');
  const clean = raw.trim().replace(/^\./, '').toLowerCase();
  if (clean === 'docx' || clean === 'word') return 'docx';
  if (clean === 'md' || clean === 'markdown') return 'md';
  return null;
}

export function extractDocxMediaEntries(entries: ArchiveEntryVo[]): ArchiveEntryVo[] {
  return entries
    .filter((e) => e.path.startsWith('word/media/') && !e.isDirectory)
    .map((img) => {
      const imgFileName = img.path.replace(/^word\/media\//, '');
      return ArchiveEntryVo.create(`media/${imgFileName}`, img.data, false);
    });
}

function renderLatexArticleEnvelope(params: {
  title: string;
  author?: string;
  date?: string;
  abstractText?: string;
  bodyLines: string[];
}): string {
  const {
    title,
    author = 'Author',
    date = '\\today',
    abstractText,
    bodyLines,
  } = params;

  const abstractBlock = abstractText
    ? `\\begin{abstract}\n${escapeLatex(abstractText)}\n\\end{abstract}\n\n`
    : '';

  return `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{booktabs}

\\title{\\textbf{${escapeLatex(title)}}}
\\author{${escapeLatex(author)}}
\\date{${date === '\\today' ? '\\today' : escapeLatex(date)}}

\\begin{document}
\\maketitle

${abstractBlock}${bodyLines.join('\n')}

\\end{document}
`;
}

const UNSHIELD_TOKEN_RE = /@@FLUXTOK(\d+)@@/g;

function transpileInlineMarkdown(text: string): string {
  const shieldedTokens: string[] = [];
  const shield = (latexFragment: string): string => {
    const idx = shieldedTokens.length;
    shieldedTokens.push(latexFragment);
    return `@@FLUXTOK${idx}@@`;
  };

  let out = text;
  out = out.replace(/`([^`]+)`/g, (_, code: string) =>
    shield(`\\texttt{${escapeLatex(code)}}`),
  );
  out = out.replace(/\$([^$]+)\$/g, (_, math: string) => shield(`$${math}$`));
  out = out.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_, alt: string, url: string) =>
      shield(
        `\\begin{figure}[htbp]\\centering\\includegraphics[width=0.8\\textwidth]{${sanitizeLatexUrl(url)}}\\caption{${escapeLatex(alt)}}\\end{figure}`,
      ),
  );
  out = out.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, linkText: string, url: string) =>
      shield(`\\href{${sanitizeLatexUrl(url)}}{${escapeLatex(linkText)}}`),
  );
  out = out.replace(/(\*\*\*|___)(.+?)\1/g, (_, __, body: string) =>
    shield(`\\textbf{\\textit{${escapeLatex(body)}}}`),
  );
  out = out.replace(/(\*\*|__)(.+?)\1/g, (_, __, body: string) =>
    shield(`\\textbf{${escapeLatex(body)}}`),
  );
  out = out.replace(/(\*|_)(.+?)\1/g, (_, __, body: string) =>
    shield(`\\textit{${escapeLatex(body)}}`),
  );

  out = escapeLatex(out);
  if (shieldedTokens.length === 0) return out;
  return out.replace(
    UNSHIELD_TOKEN_RE,
    (_, rawIdx: string) => shieldedTokens[Number(rawIdx)] ?? '',
  );
}

export function transpileMarkdownToLatex(
  content: string,
  fileName?: string,
): TranspiledProjectResult {
  const lines = content.replace(/\r\n/g, '\n').split('\n');

  let title = fileName
    ? fileName.replace(/\.[^/.]+$/, '')
    : 'Untitled Document';
  let author = 'Author';
  let date = '\\today';
  let abstractText = '';
  let startLine = 0;

  if (lines[0]?.trim() === '---') {
    let fmEnd = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        fmEnd = i;
        break;
      }
    }
    if (fmEnd !== -1) {
      for (let i = 1; i < fmEnd; i++) {
        const colonIdx = lines[i].indexOf(':');
        if (colonIdx !== -1) {
          const key = lines[i].slice(0, colonIdx).trim().toLowerCase();
          const val = lines[i]
            .slice(colonIdx + 1)
            .trim()
            .replace(/^["']|["']$/g, '');
          if (key === 'title') title = val;
          if (key === 'author') author = val;
          if (key === 'date') date = val;
          if (key === 'abstract') abstractText = val;
        }
      }
      startLine = fmEnd + 1;
    }
  }

  const latexBody: string[] = [];
  let inCodeBlock = false;
  let inList: 'itemize' | 'enumerate' | null = null;
  let inQuote = false;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        latexBody.push('\\end{verbatim}\n');
        inCodeBlock = false;
      } else {
        if (inList) {
          latexBody.push(`\\end{${inList}}\n`);
          inList = null;
        }
        latexBody.push('\\begin{verbatim}');
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      latexBody.push(line);
      continue;
    }

    if (
      line.trim().startsWith('$$') &&
      line.trim().endsWith('$$') &&
      line.trim().length > 4
    ) {
      const math = line.trim().slice(2, -2).trim();
      latexBody.push(`\\begin{equation}\n  ${math}\n\\end{equation}\n`);
      continue;
    }

    const unorderedMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (unorderedMatch) {
      if (inList !== 'itemize') {
        if (inList) latexBody.push(`\\end{${inList}}`);
        latexBody.push('\\begin{itemize}');
        inList = 'itemize';
      }
      latexBody.push(`  \\item ${transpileInlineMarkdown(unorderedMatch[2])}`);
      continue;
    }

    const orderedMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (orderedMatch) {
      if (inList !== 'enumerate') {
        if (inList) latexBody.push(`\\end{${inList}}`);
        latexBody.push('\\begin{enumerate}');
        inList = 'enumerate';
      }
      latexBody.push(`  \\item ${transpileInlineMarkdown(orderedMatch[2])}`);
      continue;
    }

    if (inList && line.trim() === '') {
      latexBody.push(`\\end{${inList}}\n`);
      inList = null;
      continue;
    }

    if (line.trim().startsWith('>')) {
      const quoteContent = line.replace(/^\s*>\s?/, '');
      if (!inQuote) {
        latexBody.push('\\begin{quote}');
        inQuote = true;
      }
      latexBody.push(transpileInlineMarkdown(quoteContent));
      continue;
    } else if (inQuote) {
      latexBody.push('\\end{quote}\n');
      inQuote = false;
    }

    const h1Match = line.match(/^#\s+(.*)$/);
    if (h1Match) {
      latexBody.push(`\\section{${transpileInlineMarkdown(h1Match[1])}}\n`);
      continue;
    }
    const h2Match = line.match(/^##\s+(.*)$/);
    if (h2Match) {
      latexBody.push(`\\subsection{${transpileInlineMarkdown(h2Match[1])}}\n`);
      continue;
    }
    const h3Match = line.match(/^###\s+(.*)$/);
    if (h3Match) {
      latexBody.push(`\\subsubsection{${transpileInlineMarkdown(h3Match[1])}}\n`);
      continue;
    }
    const h4Match = line.match(/^####\s+(.*)$/);
    if (h4Match) {
      latexBody.push(`\\paragraph{${transpileInlineMarkdown(h4Match[1])}}\n`);
      continue;
    }

    if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
      latexBody.push('\\noindent\\rule{\\textwidth}{0.5pt}\n');
      continue;
    }

    latexBody.push(line.trim() === '' ? '' : transpileInlineMarkdown(line));
  }

  if (inCodeBlock) latexBody.push('\\end{verbatim}');
  if (inList) latexBody.push(`\\end{${inList}}`);
  if (inQuote) latexBody.push('\\end{quote}');

  const mainTex = renderLatexArticleEnvelope({
    title,
    author,
    date,
    abstractText,
    bodyLines: latexBody,
  });

  return {
    mainTex,
    entries: [ArchiveEntryVo.create('main.tex', Buffer.from(mainTex, 'utf8'), false)],
    detectedTitle: title,
    warnings: [],
  };
}

const DOCX_TEXT_NODE_RE = /<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g;
const DOCX_RUN_OR_BLIP_RE =
  /<w:r(?: [^>]*)?>([\s\S]*?)<\/w:r>|<a:blip[^>]*r:embed="([^"]+)"/g;
const DOCX_BLIP_IN_RUN_RE = /<a:blip[^>]*r:embed="([^"]+)"/g;
const DOCX_BOLD_RE =
  /<w:b(?:\s+w:val="(?!0|false|none)[^"]*")?\s*\/>|<w:b>(?:1|true)<\/w:b>/i;
const DOCX_ITALIC_RE =
  /<w:i(?:\s+w:val="(?!0|false|none)[^"]*")?\s*\/>|<w:i>(?:1|true)<\/w:i>/i;
const DOCX_UNDERLINE_RE = /<w:u(?:\s+w:val="(?!0|false|none)[^"]*")?\s*\/>/i;

function formatDocxFigure(relsMap: Map<string, string>, rId: string): string | null {
  const target = relsMap.get(rId);
  if (!target) return null;
  const rawPath = target.startsWith('media/')
    ? target
    : `media/${target.replace(/^.*[\\/]/, '')}`;
  return `\n\\begin{figure}[htbp]\\centering\\includegraphics[width=0.75\\textwidth]{${sanitizeLatexUrl(rawPath)}}\\end{figure}\n`;
}

function extractPlainTextFromParagraph(pXml: string): string {
  DOCX_TEXT_NODE_RE.lastIndex = 0;
  let tMatch: RegExpExecArray | null;
  let out = '';
  while ((tMatch = DOCX_TEXT_NODE_RE.exec(pXml)) !== null) {
    out += unescapeXml(tMatch[1]);
  }
  return out.trim();
}

function parseRunsInParagraph(pXml: string, relsMap: Map<string, string>): string {
  const parts: string[] = [];
  DOCX_RUN_OR_BLIP_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = DOCX_RUN_OR_BLIP_RE.exec(pXml)) !== null) {
    const [, rXml, standaloneEmbedId] = match;
    if (standaloneEmbedId) {
      const fig = formatDocxFigure(relsMap, standaloneEmbedId);
      if (fig) parts.push(fig);
      continue;
    }
    if (!rXml) continue;

    DOCX_BLIP_IN_RUN_RE.lastIndex = 0;
    let blipMatch: RegExpExecArray | null;
    while ((blipMatch = DOCX_BLIP_IN_RUN_RE.exec(rXml)) !== null) {
      const fig = formatDocxFigure(relsMap, blipMatch[1]);
      if (fig) parts.push(fig);
    }

    DOCX_TEXT_NODE_RE.lastIndex = 0;
    let tMatch: RegExpExecArray | null;
    let runText = '';
    while ((tMatch = DOCX_TEXT_NODE_RE.exec(rXml)) !== null) {
      runText += tMatch[1];
    }
    if (!runText) continue;

    const isBold = DOCX_BOLD_RE.test(rXml);
    const isItalic = DOCX_ITALIC_RE.test(rXml);
    const isUnderline = DOCX_UNDERLINE_RE.test(rXml);

    let formatted = escapeLatex(unescapeXml(runText));
    if (isBold && isItalic) formatted = `\\textbf{\\textit{${formatted}}}`;
    else if (isBold) formatted = `\\textbf{${formatted}}`;
    else if (isItalic) formatted = `\\textit{${formatted}}`;
    else if (isUnderline) formatted = `\\underline{${formatted}}`;

    parts.push(formatted);
  }

  return parts.join('');
}

export function transpileDocxEntriesToLatex(
  entries: ArchiveEntryVo[],
  fileName?: string,
): TranspiledProjectResult {
  const docXmlEntry = entries.find((e) => e.path === 'word/document.xml');
  if (!docXmlEntry) {
    throw new InvalidZipArchiveException(
      'Invalid DOCX format: word/document.xml missing.',
    );
  }

  const relsEntry = entries.find((e) => e.path === 'word/_rels/document.xml.rels');
  const relsMap = new Map<string, string>();
  if (relsEntry) {
    const relsXml = relsEntry.data.toString('utf8');
    const relTagRegex = /<Relationship\b[^>]*>/g;
    let tagMatch;
    while ((tagMatch = relTagRegex.exec(relsXml)) !== null) {
      const tag = tagMatch[0];
      const idMatch = tag.match(/\bId="([^"]+)"/i);
      const targetMatch = tag.match(/\bTarget="([^"]+)"/i);
      if (idMatch && targetMatch) {
        relsMap.set(idMatch[1], targetMatch[1]);
      }
    }
  }

  const mediaEntries = extractDocxMediaEntries(entries);
  const docXml = docXmlEntry.data.toString('utf8');
  const defaultTitle = fileName
    ? fileName.replace(/\.[^/.]+$/, '')
    : 'Word Imported Document';
  let detectedTitle = defaultTitle;
  let isFirstHeading = true;

  const latexBody: string[] = [];
  let inList: 'itemize' | 'enumerate' | null = null;

  const pRegex = /<w:p(?: [^>]*)?>([\s\S]*?)<\/w:p>/g;
  let pMatch;

  while ((pMatch = pRegex.exec(docXml)) !== null) {
    const pXml = pMatch[1];
    const styleMatch = pXml.match(/<w:pStyle[^>]*w:val="([^"]+)"/);
    const styleVal = styleMatch ? styleMatch[1].toLowerCase() : '';
    const isListItem = /<w:numPr[ >]/.test(pXml);

    const pText = parseRunsInParagraph(pXml, relsMap);
    const rawPlainText = extractPlainTextFromParagraph(pXml);
    if (!pText.trim()) continue;

    if (styleVal.includes('title')) {
      detectedTitle = rawPlainText || unescapeXml(pText);
      continue;
    }

    if (styleVal.includes('heading1') || styleVal === '1') {
      if (inList) {
        latexBody.push(`\\end{${inList}}\n`);
        inList = null;
      }
      if (isFirstHeading && !detectedTitle) {
        detectedTitle = rawPlainText || unescapeXml(pText);
        isFirstHeading = false;
      }
      latexBody.push(`\\section{${pText}}\n`);
      continue;
    }

    if (styleVal.includes('heading2') || styleVal === '2') {
      if (inList) {
        latexBody.push(`\\end{${inList}}\n`);
        inList = null;
      }
      latexBody.push(`\\subsection{${pText}}\n`);
      continue;
    }

    if (styleVal.includes('heading3') || styleVal === '3') {
      if (inList) {
        latexBody.push(`\\end{${inList}}\n`);
        inList = null;
      }
      latexBody.push(`\\subsubsection{${pText}}\n`);
      continue;
    }

    if (isListItem) {
      if (!inList) {
        latexBody.push('\\begin{itemize}');
        inList = 'itemize';
      }
      latexBody.push(`  \\item ${pText}`);
      continue;
    }

    if (inList) {
      latexBody.push(`\\end{${inList}}\n`);
      inList = null;
    }

    latexBody.push(`${pText}\n`);
  }

  if (inList) {
    latexBody.push(`\\end{${inList}}\n`);
  }

  const mainTex = renderLatexArticleEnvelope({
    title: detectedTitle,
    author: 'Imported Author',
    bodyLines: latexBody,
  });

  const mainEntry = ArchiveEntryVo.create(
    'main.tex',
    Buffer.from(mainTex, 'utf8'),
    false,
  );

  return {
    mainTex,
    entries: [mainEntry, ...mediaEntries],
    detectedTitle,
    warnings: [],
  };
}
