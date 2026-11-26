/**
 * modules/pages/export-import/domain/latex-import.domain.ts
 *
 * GoF Strategy + Registry + Template Method for converting Word (.docx) and Markdown (.md / .markdown)
 * documents into compilable LaTeX project entries without external CLI dependencies.
 */

import {
  Injectable,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import * as path from 'node:path';
import { ArchiveEntryVo } from './archive.domain';
import { IDocumentTranspilerPort, IZipEnginePort } from './archive.ports';
import type { TranspiledProjectResult } from '../types/archive.types';
import {
  escapeLatex,
  sanitizeLatexUrl,
  unescapeXml,
} from './latex-export.domain';
import { ZipAdapter } from '../adapters/zip.adapter';

export { escapeLatex, sanitizeLatexUrl, unescapeXml };

export type SupportedImportFormat = 'docx' | 'md';

/**
 * GoF Template Method helper: Shared LaTeX article document envelope.
 */
export function renderLatexArticleEnvelope(params: {
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

/**
 * Extracts embedded `word/media/*` binary image assets from a `.docx` archive into `media/*` entries.
 */
export function extractDocxMediaEntries(entries: ArchiveEntryVo[]): ArchiveEntryVo[] {
  return entries
    .filter((e) => e.path.startsWith('word/media/') && !e.isDirectory)
    .map((img) => {
      const imgFileName = img.path.replace(/^word\/media\//, '');
      return ArchiveEntryVo.create(`media/${imgFileName}`, img.data, false);
    });
}

/**
 * GoF Strategy interface for inbound document format transpilers.
 */
export interface IDocumentImportStrategy {
  readonly format: SupportedImportFormat;
  readonly aliases: readonly string[];
  transpile(buffer: Buffer, fileName?: string): Promise<TranspiledProjectResult>;
}

class MarkdownImportStrategy implements IDocumentImportStrategy {
  public readonly format = 'md' as const;
  public readonly aliases = ['markdown'] as const;

  public async transpile(
    buffer: Buffer,
    fileName?: string,
  ): Promise<TranspiledProjectResult> {
    return this.transpileText(buffer.toString('utf8'), fileName);
  }

  public async transpileText(
    content: string,
    fileName?: string,
  ): Promise<TranspiledProjectResult> {
    const warnings: string[] = [];
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
        latexBody.push(
          `  \\item ${this.transpileInlineMarkdown(unorderedMatch[2])}`,
        );
        continue;
      }

      const orderedMatch = line.match(/^(\s*)\d+\.\s+(.*)$/);
      if (orderedMatch) {
        if (inList !== 'enumerate') {
          if (inList) latexBody.push(`\\end{${inList}}`);
          latexBody.push('\\begin{enumerate}');
          inList = 'enumerate';
        }
        latexBody.push(
          `  \\item ${this.transpileInlineMarkdown(orderedMatch[2])}`,
        );
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
        latexBody.push(this.transpileInlineMarkdown(quoteContent));
        continue;
      } else if (inQuote) {
        latexBody.push('\\end{quote}\n');
        inQuote = false;
      }

      const h1Match = line.match(/^#\s+(.*)$/);
      if (h1Match) {
        latexBody.push(`\\section{${this.transpileInlineMarkdown(h1Match[1])}}\n`);
        continue;
      }
      const h2Match = line.match(/^##\s+(.*)$/);
      if (h2Match) {
        latexBody.push(`\\subsection{${this.transpileInlineMarkdown(h2Match[1])}}\n`);
        continue;
      }
      const h3Match = line.match(/^###\s+(.*)$/);
      if (h3Match) {
        latexBody.push(`\\subsubsection{${this.transpileInlineMarkdown(h3Match[1])}}\n`);
        continue;
      }
      const h4Match = line.match(/^####\s+(.*)$/);
      if (h4Match) {
        latexBody.push(`\\paragraph{${this.transpileInlineMarkdown(h4Match[1])}}\n`);
        continue;
      }

      if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
        latexBody.push('\\noindent\\rule{\\textwidth}{0.5pt}\n');
        continue;
      }

      latexBody.push(line.trim() === '' ? '' : this.transpileInlineMarkdown(line));
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

    const mainEntry = ArchiveEntryVo.create(
      'main.tex',
      Buffer.from(mainTex, 'utf8'),
      false,
    );

    return {
      mainTex,
      entries: [mainEntry],
      detectedTitle: title,
      warnings,
    };
  }

  private transpileInlineMarkdown(text: string): string {
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
    for (let i = shieldedTokens.length - 1; i >= 0; i--) {
      out = out.replace(`@@FLUXTOK${i}@@`, () => shieldedTokens[i]);
    }
    return out;
  }
}

class DocxImportStrategy implements IDocumentImportStrategy {
  public readonly format = 'docx' as const;
  public readonly aliases = ['word'] as const;

  constructor(private readonly zipEngine: IZipEnginePort) {}

  public async transpile(
    docxBuffer: Buffer,
    fileName?: string,
  ): Promise<TranspiledProjectResult> {
    const warnings: string[] = [];
    const entries = this.zipEngine.extractZip(docxBuffer);

    const docXmlEntry = entries.find((e) => e.path === 'word/document.xml');
    if (!docXmlEntry) {
      throw new BadRequestException(
        'Invalid DOCX format: word/document.xml missing.',
      );
    }

    const relsEntry = entries.find(
      (e) => e.path === 'word/_rels/document.xml.rels',
    );
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

      const pText = this.parseRunsInParagraph(pXml, relsMap);
      const rawPlainText = this.extractPlainTextFromParagraph(pXml);
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
      warnings,
    };
  }

  private extractPlainTextFromParagraph(pXml: string): string {
    const tRegex = /<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g;
    let tMatch;
    let out = '';
    while ((tMatch = tRegex.exec(pXml)) !== null) {
      out += unescapeXml(tMatch[1]);
    }
    return out.trim();
  }

  private parseRunsInParagraph(
    pXml: string,
    relsMap: Map<string, string>,
  ): string {
    const parts: string[] = [];

    const blipRegex = /<a:blip[^>]*r:embed="([^"]+)"/g;
    let blipMatch;
    while ((blipMatch = blipRegex.exec(pXml)) !== null) {
      const rId = blipMatch[1];
      const target = relsMap.get(rId);
      if (target) {
        const rawPath = target.startsWith('media/')
          ? target
          : `media/${target.replace(/^.*[\\/]/, '')}`;
        const cleanPath = sanitizeLatexUrl(rawPath);
        parts.push(
          `\n\\begin{figure}[htbp]\\centering\\includegraphics[width=0.75\\textwidth]{${cleanPath}}\\end{figure}\n`,
        );
      }
    }

    const rRegex = /<w:r(?: [^>]*)?>([\s\S]*?)<\/w:r>/g;
    let rMatch;

    while ((rMatch = rRegex.exec(pXml)) !== null) {
      const rXml = rMatch[1];
      const isBold =
        /<w:b(?:\s+w:val="(?!0|false|none)[^"]*")?\s*\/>|<w:b>(?:1|true)<\/w:b>/i.test(
          rXml,
        );
      const isItalic =
        /<w:i(?:\s+w:val="(?!0|false|none)[^"]*")?\s*\/>|<w:i>(?:1|true)<\/w:i>/i.test(
          rXml,
        );
      const isUnderline =
        /<w:u(?:\s+w:val="(?!0|false|none)[^"]*")?\s*\/>/i.test(rXml);

      const tRegex = /<w:t(?: [^>]*)?>([\s\S]*?)<\/w:t>/g;
      let tMatch;
      let runText = '';
      while ((tMatch = tRegex.exec(rXml)) !== null) {
        runText += tMatch[1];
      }
      if (!runText) continue;

      let formatted = escapeLatex(unescapeXml(runText));
      if (isBold && isItalic) formatted = `\\textbf{\\textit{${formatted}}}`;
      else if (isBold) formatted = `\\textbf{${formatted}}`;
      else if (isItalic) formatted = `\\textit{${formatted}}`;
      else if (isUnderline) formatted = `\\underline{${formatted}}`;

      parts.push(formatted);
    }

    return parts.join('');
  }
}

export class ImportFormatRegistry {
  private readonly strategies = new Map<string, IDocumentImportStrategy>();

  constructor(strategies: ReadonlyArray<IDocumentImportStrategy>) {
    for (const s of strategies) {
      this.register(s);
    }
  }

  public register(strategy: IDocumentImportStrategy): this {
    this.strategies.set(strategy.format.toLowerCase(), strategy);
    for (const alias of strategy.aliases) {
      this.strategies.set(alias.toLowerCase(), strategy);
    }
    return this;
  }

  public resolve(formatOrExt?: string): IDocumentImportStrategy | null {
    if (!formatOrExt) return null;
    const key = formatOrExt.trim().replace(/^\./, '').toLowerCase();
    return this.strategies.get(key) ?? null;
  }
}

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

@Injectable()
export class LatexImportTranspiler extends IDocumentTranspilerPort {
  private readonly markdownStrategy: MarkdownImportStrategy;
  private readonly docxStrategy: DocxImportStrategy;
  private readonly registry: ImportFormatRegistry;

  constructor(@Optional() zipEngine?: IZipEnginePort) {
    super();
    const resolvedZip = zipEngine ?? new ZipAdapter();
    this.markdownStrategy = new MarkdownImportStrategy();
    this.docxStrategy = new DocxImportStrategy(resolvedZip);
    this.registry = new ImportFormatRegistry([
      this.markdownStrategy,
      this.docxStrategy,
    ]);
  }

  public async transpileByFormat(
    format: SupportedImportFormat,
    buffer: Buffer,
    fileName?: string,
  ): Promise<TranspiledProjectResult> {
    const strategy = this.registry.resolve(format);
    if (!strategy) {
      throw new BadRequestException(`Unsupported import format: "${format}"`);
    }
    return strategy.transpile(buffer, fileName);
  }

  public async transpileMarkdown(
    content: string,
    fileName?: string,
  ): Promise<TranspiledProjectResult> {
    return this.markdownStrategy.transpileText(content, fileName);
  }

  public async transpileDocx(
    docxBuffer: Buffer,
    fileName?: string,
  ): Promise<TranspiledProjectResult> {
    return this.docxStrategy.transpile(docxBuffer, fileName);
  }
}

export type { TranspiledProjectResult };
