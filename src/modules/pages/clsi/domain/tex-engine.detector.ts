/**
 * modules/manuscripts/clsi/domain/tex-engine.detector.ts
 * Pure in-process domain logic inspecting TeX source code for TeX magic comments
 * (% !TEX program = ...) and package hints (fontspec, luacode) to select the compiler.
 */

import { VIETNAMESE_LATIN_REGEX } from '@/modules/pages/core/domain/latex-preamble';
import { DraftModeManager } from './draft-mode.manager';

export type SupportedEngine = 'pdflatex' | 'xelatex' | 'lualatex';

export interface EngineDetectionResult {
  engine: SupportedEngine;
  detectedFrom:
    | 'explicit'
    | 'magic-comment'
    | 'package-hint'
    | 'unicode-hint'
    | 'default';
  mainFileHint?: string;
  bibProgramHint?: 'biber' | 'bibtex';
  /** Detected constructs for user advisory diagnostics; never used to enable shell escape. */
  shellEscapeAdvisories?: string[];
}

export class TexEngineDetector {
  private static readonly MAGIC_PROGRAM_REGEX =
    /(?:%\s*!TEX\s+(?:TS-program|program)\s*=\s*|%\s*!TeX\s+program\s*=\s*)([a-zA-Z0-9_-]+)/i;

  private static readonly MAGIC_ROOT_REGEX =
    /(?:%\s*!TEX\s+root\s*=\s*|%\s*!TeX\s+root\s*=\s*)([^\r\n]+)/i;

  private static readonly MAGIC_BIB_REGEX =
    /(?:%\s*!BIB\s+program\s*=\s*|%\s*!Bib\s+program\s*=\s*)([a-zA-Z0-9_-]+)/i;

  public static detect(
    source: string,
    requestedEngine?: string,
  ): EngineDetectionResult {
    const shellEscapeAdvisories = DraftModeManager.detectShellEscapeUsage(
      source || '',
    );

    const normalizedRequested = requestedEngine?.toLowerCase();
    if (
      normalizedRequested === 'xelatex' ||
      normalizedRequested === 'lualatex'
    ) {
      return {
        engine: normalizedRequested,
        detectedFrom: 'explicit',
        shellEscapeAdvisories,
      };
    }

    if (!source) {
      return {
        engine: 'pdflatex',
        detectedFrom: normalizedRequested === 'pdflatex' ? 'explicit' : 'default',
        shellEscapeAdvisories: [],
      };
    }

    const firstLines = source.split(/\r?\n/).slice(0, 50).join('\n');

    const programMatch = firstLines.match(this.MAGIC_PROGRAM_REGEX);
    let magicEngine: SupportedEngine | undefined;

    if (programMatch && programMatch[1]) {
      const prog = programMatch[1].toLowerCase();
      if (prog === 'xelatex' || prog === 'xetex') {
        magicEngine = 'xelatex';
      } else if (prog === 'lualatex' || prog === 'luatex') {
        magicEngine = 'lualatex';
      } else if (prog === 'pdflatex' || prog === 'pdftex') {
        magicEngine = 'pdflatex';
      }
    }

    const rootMatch = firstLines.match(this.MAGIC_ROOT_REGEX);
    const mainFileHint = rootMatch ? rootMatch[1].trim() : undefined;

    const bibMatch = firstLines.match(this.MAGIC_BIB_REGEX);
    let bibProgramHint: 'biber' | 'bibtex' | undefined;
    if (bibMatch && bibMatch[1]) {
      const bib = bibMatch[1].toLowerCase();
      if (bib === 'biber') bibProgramHint = 'biber';
      if (bib === 'bibtex') bibProgramHint = 'bibtex';
    }

    if (magicEngine) {
      return {
        engine: magicEngine,
        detectedFrom: 'magic-comment',
        mainFileHint,
        bibProgramHint,
        shellEscapeAdvisories,
      };
    }

    if (
      /\\usepackage(\[[^\]]*\])?\{luacode\}/.test(source) ||
      /\\usepackage(\[[^\]]*\])?\{luatex85\}/.test(source)
    ) {
      return {
        engine: 'lualatex',
        detectedFrom: 'package-hint',
        mainFileHint,
        bibProgramHint,
        shellEscapeAdvisories,
      };
    }

    if (
      /\\usepackage(\[[^\]]*\])?\{fontspec\}/.test(source) ||
      /\\usepackage(\[[^\]]*\])?\{unicode-math\}/.test(source)
    ) {
      return {
        engine: 'xelatex',
        detectedFrom: 'package-hint',
        mainFileHint,
        bibProgramHint,
        shellEscapeAdvisories,
      };
    }

    const uncommented = source
      .replace(/(^|[^\\])%[^\r\n]*/g, '$1')
      .normalize('NFC');
    const hasVietnamese = VIETNAMESE_LATIN_REGEX.test(uncommented);
    const hasVietnamesePdfLatexPkg =
      /\\usepackage(?:\[[^\]]*\])?\{vietnam\}|\\usepackage\[[^\]]*\bT5\b[^\]]*\]\{fontenc\}|\\usepackage\[[^\]]*\bvietnamese\b[^\]]*\]\{babel\}/.test(
        uncommented,
      );

    let hasNonLatin = false;
    for (const ch of uncommented) {
      const cp = ch.codePointAt(0);
      if (
        cp !== undefined &&
        cp > 0x024f &&
        !(cp >= 0x1e00 && cp <= 0x1eff) &&
        !(cp >= 0x2000 && cp <= 0x206f)
      ) {
        hasNonLatin = true;
        break;
      }
    }

    if ((hasVietnamese && !hasVietnamesePdfLatexPkg) || hasNonLatin) {
      return {
        engine: 'xelatex',
        detectedFrom: 'unicode-hint',
        mainFileHint,
        bibProgramHint,
        shellEscapeAdvisories,
      };
    }

    return {
      engine: 'pdflatex',
      detectedFrom: normalizedRequested === 'pdflatex' ? 'explicit' : 'default',
      mainFileHint,
      bibProgramHint,
      shellEscapeAdvisories,
    };
  }

  public static detectMainFile(files: Record<string, string>): string | null {
    const primaryCandidates: string[] = [];
    const subfileCandidates: string[] = [];

    for (const [filename, content] of Object.entries(files)) {
      if (!filename.endsWith('.tex')) continue;
      const uncommented = content
        .split(/\r?\n/)
        .map((l) => l.split(/(?<!\\)%/)[0])
        .join('\n')
        .replace(/\\iffalse\b[\s\S]*?\\fi\b/g, '');
      const match = uncommented.match(
        /\\documentclass\s*(?:\[[\s\S]*?\])?\s*\{([^}]+)\}/i,
      );
      if (match && match[1]) {
        if (match[1].trim().toLowerCase() === 'subfiles') {
          subfileCandidates.push(filename);
        } else {
          primaryCandidates.push(filename);
        }
      }
    }

    const candidates =
      primaryCandidates.length > 0 ? primaryCandidates : subfileCandidates;

    if (candidates.length === 1) {
      return candidates[0];
    }

    const commonNames = [
      'main.tex',
      'ms.tex',
      'document.tex',
      'paper.tex',
      'thesis.tex',
      'index.tex',
    ];
    for (const name of commonNames) {
      if (candidates.includes(name)) {
        return name;
      }
    }

    return candidates[0] || null;
  }
}
