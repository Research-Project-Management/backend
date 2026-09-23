/**
 * modules/manuscripts/clsi/core/adapters/engines/tex-engine.detector.ts
 * Inspects TeX source code for TeX magic comments (% !TEX program = ...)
 * and package hints (fontspec, luacode) to automatically select the optimal compiler.
 * Matches Overleaf CLSI compiler auto-detection semantics.
 */

export type SupportedEngine = 'pdflatex' | 'xelatex' | 'lualatex' | 'tectonic';

export interface EngineDetectionResult {
  engine: SupportedEngine;
  detectedFrom: 'explicit' | 'magic-comment' | 'package-hint' | 'default';
  mainFileHint?: string;
  bibProgramHint?: 'biber' | 'bibtex';
}

export class TexEngineDetector {
  // Regex patterns for TeX Magic Comments (TeXShop, TeXworks, Overleaf)
  private static readonly MAGIC_PROGRAM_REGEX =
    /(?:%\s*!TEX\s+(?:TS-program|program)\s*=\s*|%\s*!TeX\s+program\s*=\s*)([a-zA-Z0-9_-]+)/i;

  private static readonly MAGIC_ROOT_REGEX =
    /(?:%\s*!TEX\s+root\s*=\s*|%\s*!TeX\s+root\s*=\s*)([^\r\n]+)/i;

  private static readonly MAGIC_BIB_REGEX =
    /(?:%\s*!BIB\s+program\s*=\s*|%\s*!Bib\s+program\s*=\s*)([a-zA-Z0-9_-]+)/i;

  /**
   * Detects the appropriate compilation engine based on:
   * 1. Explicit request from DTO (if provided and not 'auto')
   * 2. TeX magic comments in the source (% !TEX program = ...)
   * 3. Package dependencies that strictly require XeTeX or LuaTeX (fontspec, luacode)
   * 4. Default fallback: pdflatex
   */
  public static detect(
    source: string,
    requestedEngine?: string
  ): EngineDetectionResult {
    // 1. Explicit request takes priority unless set to 'auto' or empty
    if (requestedEngine && requestedEngine !== 'auto') {
      const normalized = requestedEngine.toLowerCase();
      if (
        normalized === 'pdflatex' ||
        normalized === 'xelatex' ||
        normalized === 'lualatex' ||
        normalized === 'tectonic'
      ) {
        return {
          engine: normalized as SupportedEngine,
          detectedFrom: 'explicit',
        };
      }
    }

    if (!source) {
      return { engine: 'pdflatex', detectedFrom: 'default' };
    }

    // Inspect the first 50 lines for magic comments
    const firstLines = source.split(/\r?\n/).slice(0, 50).join('\n');

    // 2. Check for % !TEX program = ...
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

    // Check for % !TEX root = ...
    const rootMatch = firstLines.match(this.MAGIC_ROOT_REGEX);
    const mainFileHint = rootMatch ? rootMatch[1].trim() : undefined;

    // Check for % !BIB program = ...
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
      };
    }

    // 3. Package hints:
    // luacode or luatex85 requires lualatex
    if (
      /\\usepackage(\[[^\]]*\])?\{luacode\}/.test(source) ||
      /\\usepackage(\[[^\]]*\])?\{luatex85\}/.test(source)
    ) {
      return {
        engine: 'lualatex',
        detectedFrom: 'package-hint',
        mainFileHint,
        bibProgramHint,
      };
    }

    // fontspec or unicode-math requires xelatex or lualatex (fails on pdflatex)
    if (
      /\\usepackage(\[[^\]]*\])?\{fontspec\}/.test(source) ||
      /\\usepackage(\[[^\]]*\])?\{unicode-math\}/.test(source)
    ) {
      return {
        engine: 'xelatex',
        detectedFrom: 'package-hint',
        mainFileHint,
        bibProgramHint,
      };
    }

    // 4. Default fallback
    return {
      engine: 'pdflatex',
      detectedFrom: 'default',
      mainFileHint,
      bibProgramHint,
    };
  }

  /**
   * Attempts to determine the main file among a dictionary of project files
   * by finding the file containing \documentclass and not included by other files.
   */
  public static detectMainFile(files: Record<string, string>): string | null {
    const candidates: string[] = [];

    for (const [filename, content] of Object.entries(files)) {
      if (filename.endsWith('.tex') && /\\documentclass/i.test(content)) {
        candidates.push(filename);
      }
    }

    if (candidates.length === 1) {
      return candidates[0];
    }

    // Prefer common names if multiple candidates exist
    const commonNames = ['main.tex', 'document.tex', 'paper.tex', 'thesis.tex', 'index.tex'];
    for (const name of commonNames) {
      if (candidates.includes(name)) {
        return name;
      }
    }

    return candidates[0] || null;
  }
}
