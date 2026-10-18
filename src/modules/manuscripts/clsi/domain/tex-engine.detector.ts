/**
 * modules/manuscripts/clsi/domain/tex-engine.detector.ts
 * Pure in-process domain logic inspecting TeX source code for TeX magic comments
 * (% !TEX program = ...) and package hints (fontspec, luacode) to select the compiler.
 */

import { DraftModeManager } from './draft-mode.manager';

export type SupportedEngine = 'pdflatex' | 'xelatex' | 'lualatex' | 'tectonic';

export interface EngineDetectionResult {
  engine: SupportedEngine;
  detectedFrom: 'explicit' | 'magic-comment' | 'package-hint' | 'default';
  mainFileHint?: string;
  bibProgramHint?: 'biber' | 'bibtex';
  /** Detected constructs for user advisory diagnostics; never used to enable shell escape. */
  shellEscapeAdvisories?: string[];
  /** @deprecated Advisory only. */
  requiresShellEscape?: boolean;
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
    const requiresShellEscape = shellEscapeAdvisories.length > 0;

    if (requestedEngine && requestedEngine !== 'auto') {
      const normalized = requestedEngine.toLowerCase();
      if (
        normalized === 'pdflatex' ||
        normalized === 'xelatex' ||
        normalized === 'lualatex' ||
        normalized === 'tectonic'
      ) {
        return {
          engine: normalized,
          detectedFrom: 'explicit',
          shellEscapeAdvisories,
          requiresShellEscape,
        };
      }
    }

    if (!source) {
      return {
        engine: 'pdflatex',
        detectedFrom: 'default',
        shellEscapeAdvisories: [],
        requiresShellEscape: false,
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
      } else if (prog === 'tectonic') {
        magicEngine = 'tectonic';
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
        requiresShellEscape,
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
        requiresShellEscape,
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
        requiresShellEscape,
      };
    }

    return {
      engine: 'pdflatex',
      detectedFrom: 'default',
      mainFileHint,
      bibProgramHint,
      shellEscapeAdvisories,
      requiresShellEscape,
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
