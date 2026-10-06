/**
 * export-import/core/adapters/transpiler/document-transpiler.adapter.ts
 * Driven Adapter transpiling Word (.docx) and Markdown (.md) documents into compilable LaTeX projects.
 * Zero external CLI dependencies, sandboxed, high-throughput Node.js implementation.
 */

import { Injectable, Logger } from '@nestjs/common';
import {
  IDocumentTranspilerPort,
  TranspiledProjectResult,
} from '../../ports/document-transpiler.port';
import { IZipEnginePort } from '../../ports/zip-engine.port';
import { ArchiveEntryVo } from '../../domain/value-objects/archive-entry.vo';

function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

function unescapeXml(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

@Injectable()
export class DocumentTranspilerAdapter extends IDocumentTranspilerPort {
  private readonly logger = new Logger(DocumentTranspilerAdapter.name);

  constructor(private readonly zipEngine: IZipEnginePort) {
    super();
  }

  /**
   * Transpiles CommonMark / GitHub Flavored Markdown into a full LaTeX project.
   */
  public async transpileMarkdown(
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

    // 1. Parse optional YAML frontmatter
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

      // Code blocks
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

      // Display math ($$...$$)
      if (
        line.trim().startsWith('$$') &&
        line.trim().endsWith('$$') &&
        line.trim().length > 4
      ) {
        const math = line.trim().slice(2, -2).trim();
        latexBody.push(`\\begin{equation}\n  ${math}\n\\end{equation}\n`);
        continue;
      }

      // Unordered lists
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

      // Ordered lists
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

      // If we were in a list and this line is not a list item, close it
      if (inList && line.trim() === '') {
        latexBody.push(`\\end{${inList}}\n`);
        inList = null;
        continue;
      }

      // Blockquotes
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

      // Headings
      const h1Match = line.match(/^#\s+(.*)$/);
      if (h1Match) {
        latexBody.push(
          `\\section{${this.transpileInlineMarkdown(h1Match[1])}}\n`,
        );
        continue;
      }
      const h2Match = line.match(/^##\s+(.*)$/);
      if (h2Match) {
        latexBody.push(
          `\\subsection{${this.transpileInlineMarkdown(h2Match[1])}}\n`,
        );
        continue;
      }
      const h3Match = line.match(/^###\s+(.*)$/);
      if (h3Match) {
        latexBody.push(
          `\\subsubsection{${this.transpileInlineMarkdown(h3Match[1])}}\n`,
        );
        continue;
      }
      const h4Match = line.match(/^####\s+(.*)$/);
      if (h4Match) {
        latexBody.push(
          `\\paragraph{${this.transpileInlineMarkdown(h4Match[1])}}\n`,
        );
        continue;
      }

      // Horizontal rules
      if (/^(\*{3,}|-{3,}|_{3,})$/.test(line.trim())) {
        latexBody.push('\\noindent\\rule{\\textwidth}{0.5pt}\n');
        continue;
      }

      // Regular paragraph or empty line
      if (line.trim() === '') {
        latexBody.push('');
      } else {
        latexBody.push(this.transpileInlineMarkdown(line));
      }
    }

    if (inCodeBlock) latexBody.push('\\end{verbatim}');
    if (inList) latexBody.push(`\\end{${inList}}`);
    if (inQuote) latexBody.push('\\end{quote}');

    const mainTex = `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{booktabs}

\\title{\\textbf{${escapeLatex(title)}}}
\\author{${escapeLatex(author)}}
\\date{${escapeLatex(date)}}

\\begin{document}
\\maketitle

${
  abstractText
    ? `\\begin{abstract}\n${escapeLatex(abstractText)}\n\\end{abstract}\n\n`
    : ''
}${latexBody.join('\n')}

\\end{document}
`;

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

  /**
   * Transpiles inline markdown formatting (bold, italic, code, links, images).
   */
  private transpileInlineMarkdown(text: string): string {
    let out = text;

    // Inline math $...$ preservation
    const mathTokens: string[] = [];
    out = out.replace(/\$([^\$]+)\$/g, (_, math) => {
      const idx = mathTokens.length;
      mathTokens.push(`$${math}$`);
      return `%%MATH_${idx}%%`;
    });

    // Images: ![alt](url)
    out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => {
      return `\\begin{figure}[htbp]\\centering\\includegraphics[width=0.8\\textwidth]{${url}}\\caption{${escapeLatex(alt)}}\\end{figure}`;
    });

    // Links: [text](url)
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, linkText, url) => {
      return `\\href{${url}}{${escapeLatex(linkText)}}`;
    });

    // Bold + Italic: ***text*** or ___text___
    out = out.replace(
      /(\*\*\*|___)(.*?)\1/g,
      (_, __, body) => `\\textbf{\\textit{${escapeLatex(body)}}}`,
    );

    // Bold: **text** or __text__
    out = out.replace(
      /(\*\*|__)(.*?)\1/g,
      (_, __, body) => `\\textbf{${escapeLatex(body)}}`,
    );

    // Italic: *text* or _text_
    out = out.replace(
      /(\*|_)(.*?)\1/g,
      (_, __, body) => `\\textit{${escapeLatex(body)}}`,
    );

    // Inline code: `code`
    out = out.replace(/`([^`]+)`/g, (_, code) => `\\texttt{${code}}`);

    // Restore inline math
    mathTokens.forEach((math, idx) => {
      out = out.replace(`%%MATH_${idx}%%`, math);
    });

    return out;
  }

  /**
   * Transpiles a Microsoft Word OpenXML document (.docx) into a full LaTeX project.
   */
  public async transpileDocx(
    docxBuffer: Buffer,
    fileName?: string,
  ): Promise<TranspiledProjectResult> {
    const warnings: string[] = [];
    const entries = this.zipEngine.extractZip(docxBuffer);

    const docXmlEntry = entries.find((e) => e.path === 'word/document.xml');
    if (!docXmlEntry) {
      throw new Error('Invalid DOCX format: word/document.xml missing.');
    }

    // 1. Build relationship map from word/_rels/document.xml.rels
    const relsEntry = entries.find(
      (e) => e.path === 'word/_rels/document.xml.rels',
    );
    const relsMap = new Map<string, string>();
    if (relsEntry) {
      const relsXml = relsEntry.data.toString('utf8');
      const relRegex = /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g;
      let match;
      while ((match = relRegex.exec(relsXml)) !== null) {
        relsMap.set(match[1], match[2]);
      }
    }

    // 2. Extract media images into companion entries
    const mediaEntries: ArchiveEntryVo[] = [];
    const imageEntries = entries.filter((e) =>
      e.path.startsWith('word/media/'),
    );

    for (const img of imageEntries) {
      const imgFileName = img.path.replace(/^word\/media\//, '');
      const cleanPath = `media/${imgFileName}`;
      mediaEntries.push(ArchiveEntryVo.create(cleanPath, img.data, false));
    }

    // 3. Parse OpenXML paragraphs and runs
    const docXml = docXmlEntry.data.toString('utf8');
    const defaultTitle = fileName
      ? fileName.replace(/\.[^/.]+$/, '')
      : 'Word Imported Document';
    let detectedTitle = defaultTitle;
    let isFirstHeading = true;

    const latexBody: string[] = [];
    let inList: 'itemize' | 'enumerate' | null = null;

    // Match paragraphs: <w:p ...> ... </w:p>
    const pRegex = /<w:p(?: [^>]*)?>([\s\S]*?)<\/w:p>/g;
    let pMatch;

    while ((pMatch = pRegex.exec(docXml)) !== null) {
      const pXml = pMatch[1];

      // Extract style name: <w:pStyle w:val="..."/>
      const styleMatch = pXml.match(/<w:pStyle[^>]*w:val="([^"]+)"/);
      const styleVal = styleMatch ? styleMatch[1].toLowerCase() : '';

      // Check if list item: <w:numPr>
      const isListItem = /<w:numPr[ >]/.test(pXml);

      // Extract runs and format them
      const pText = this.parseRunsInParagraph(pXml, relsMap);

      if (!pText.trim()) continue;

      if (styleVal.includes('title')) {
        detectedTitle = unescapeXml(pText);
        continue;
      }

      if (styleVal.includes('heading1') || styleVal === '1') {
        if (inList) {
          latexBody.push(`\\end{${inList}}\n`);
          inList = null;
        }
        if (isFirstHeading && !detectedTitle) {
          detectedTitle = unescapeXml(pText);
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

    const mainTex = `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}
\\usepackage{booktabs}

\\title{\\textbf{${escapeLatex(detectedTitle)}}}
\\author{Imported Author}
\\date{\\today}

\\begin{document}
\\maketitle

${latexBody.join('\n')}

\\end{document}
`;

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

  private parseRunsInParagraph(
    pXml: string,
    relsMap: Map<string, string>,
  ): string {
    const parts: string[] = [];

    // Check for drawings/images embedded in this paragraph: <a:blip r:embed="rIdX"/>
    const blipRegex = /<a:blip[^>]*r:embed="([^"]+)"/g;
    let blipMatch;
    while ((blipMatch = blipRegex.exec(pXml)) !== null) {
      const rId = blipMatch[1];
      const target = relsMap.get(rId);
      if (target) {
        const cleanPath = target.startsWith('media/')
          ? target
          : `media/${target.replace(/^.*[\\\/]/, '')}`;
        parts.push(
          `\n\\begin{figure}[htbp]\\centering\\includegraphics[width=0.75\\textwidth]{${cleanPath}}\\end{figure}\n`,
        );
      }
    }

    // Extract runs: <w:r ...> ... </w:r>
    const rRegex = /<w:r(?: [^>]*)?>([\s\S]*?)<\/w:r>/g;
    let rMatch;

    while ((rMatch = rRegex.exec(pXml)) !== null) {
      const rXml = rMatch[1];

      // Format flags
      const isBold = /<w:b(?: [^>]*)?\/>|<w:b>1<\/w:b>|<w:b>true<\/w:b>/.test(
        rXml,
      );
      const isItalic = /<w:i(?: [^>]*)?\/>|<w:i>1<\/w:i>|<w:i>true<\/w:i>/.test(
        rXml,
      );
      const isUnderline = /<w:u(?: [^>]*)?\/>/.test(rXml);

      // Extract text content: <w:t ...>text</w:t>
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
