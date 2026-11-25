/**
 * modules/pages/clsi/domain/compile.policy.ts
 * Pure compile policies for academic LaTeX documents:
 * - DraftModeManager (visual draft / syntax-only mode)
 * - TexEngineDetector (auto-detect pdflatex/xelatex/lualatex + magic comments)
 * - BibBackendDetector (auto-detect biber vs bibtex + .latexmkrc generation)
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface DraftModeApplication {
  source: string;
  isModified: boolean;
  engineFlags: string[];
}

export class DraftModeManager {
  private static readonly GRAPHICX_DRAFT_INJECTION =
    '\\PassOptionsToPackage{draft}{graphicx}';

  public static apply(
    source: string,
    options?: { draft?: boolean; syntaxOnly?: boolean },
  ): DraftModeApplication {
    if (!options?.draft && !options?.syntaxOnly) {
      return { source, isModified: false, engineFlags: [] };
    }

    const engineFlags: string[] = [];
    if (options.syntaxOnly) {
      engineFlags.push('-draftmode');
      return { source, isModified: false, engineFlags };
    }

    if (options.draft) {
      const uncommentedSource = source
        .split(/\r?\n/)
        .map((l) => l.split(/(?<!\\)%/)[0])
        .join('\n');
      if (
        uncommentedSource.includes('\\PassOptionsToPackage{draft}{graphicx}') ||
        /\\documentclass\s*\[[^\]]*\bdraft\b[^\]]*\]/i.test(uncommentedSource)
      ) {
        return { source, isModified: false, engineFlags };
      }

      const lines = source.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const cleanLine = lines[i].split(/(?<!\\)%/)[0];
        const matchIdx = cleanLine.search(/\\documentclass/i);
        if (matchIdx !== -1) {
          lines[i] =
            lines[i].slice(0, matchIdx) +
            this.GRAPHICX_DRAFT_INJECTION +
            lines[i].slice(matchIdx);
          return {
            source: lines.join('\n'),
            isModified: true,
            engineFlags,
          };
        }
      }

      return {
        source: this.GRAPHICX_DRAFT_INJECTION + source,
        isModified: true,
        engineFlags,
      };
    }

    return { source, isModified: false, engineFlags };
  }

  /**
   * Scans TeX source for constructs that historically relied on shell-escape.
   * Pure advisory function used solely for diagnostic logging; never enables compiler flags.
   */
  public static detectShellEscapeUsage(source: string): string[] {
    if (!source) return [];
    const detected: string[] = [];

    if (
      /\\usepackage(?:\[[^\]]*\])?\{(?:[^}]*,)?\s*minted\s*(?:,[^}]*)?\}/i.test(
        source,
      )
    ) {
      detected.push('minted');
    }
    if (
      /\\usepackage(?:\[[^\]]*\])?\{(?:[^}]*,)?\s*pythontex\s*(?:,[^}]*)?\}/i.test(
        source,
      )
    ) {
      detected.push('pythontex');
    }
    if (
      /\\usepackage(?:\[[^\]]*\])?\{(?:[^}]*,)?\s*svg\s*(?:,[^}]*)?\}/i.test(
        source,
      )
    ) {
      detected.push('svg');
    }
    if (
      /\\usetikzlibrary\{(?:[^}]*,)?\s*external\s*(?:,[^}]*)?\}/i.test(source)
    ) {
      detected.push('tikz-external');
    }
    if (/\\(?:immediate\\)?write18\b/.test(source)) {
      detected.push('write18');
    }

    return detected;
  }
}

/**
 * modules/pages/clsi/domain/compile.policy.ts
 * Pure in-process domain logic inspecting TeX source code for TeX magic comments
 * (% !TEX program = ...) and package hints (fontspec, luacode) to select the compiler.
 */


export type SupportedEngine = 'pdflatex' | 'xelatex' | 'lualatex';

export interface EngineDetectionResult {
  engine: SupportedEngine;
  detectedFrom: 'explicit' | 'magic-comment' | 'package-hint' | 'default';
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

    if (requestedEngine && requestedEngine !== 'auto') {
      const normalized = requestedEngine.toLowerCase();
      if (
        normalized === 'pdflatex' ||
        normalized === 'xelatex' ||
        normalized === 'lualatex'
      ) {
        return {
          engine: normalized,
          detectedFrom: 'explicit',
          shellEscapeAdvisories,
        };
      }
    }

    if (!source) {
      return {
        engine: 'pdflatex',
        detectedFrom: 'default',
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

    return {
      engine: 'pdflatex',
      detectedFrom: 'default',
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

export type BibBackend = 'biber' | 'bibtex';

export interface LatexmkrcOptions {
  engine: 'pdflatex' | 'xelatex' | 'lualatex' | 'latex';
  bibBackend: BibBackend;
  shellEscape?: boolean;
}

export class BibBackendDetector {
  public static async detect(
    source: string,
    scratchDir?: string,
    magicBibHint?: 'biber' | 'bibtex',
  ): Promise<BibBackend> {
    if (magicBibHint) {
      return magicBibHint;
    }

    if (scratchDir) {
      try {
        const entries = await fs.readdir(scratchDir);
        if (entries.some((file) => file.endsWith('.bcf'))) {
          return 'biber';
        }
      } catch {
        // Directory may not exist yet
      }
    }

    if (!source) {
      return 'bibtex';
    }

    const biblatexMatch = source.match(
      /\\usepackage(?:\[([^\]]*)\])?\{biblatex\}/i,
    );

    if (biblatexMatch) {
      const options = biblatexMatch[1] || '';
      if (/backend\s*=\s*bibtex[0-9]*/i.test(options)) {
        return 'bibtex';
      }
      return 'biber';
    }

    if (
      /\\bibliography\{/i.test(source) ||
      /\\bibliographystyle\{/i.test(source) ||
      /\\usepackage(?:\[[^\]]*\])?\{natbib\}/i.test(source)
    ) {
      return 'bibtex';
    }

    return 'bibtex';
  }

  public static generateLatexmkrc(options: LatexmkrcOptions): string {
    const lines: string[] = [
      '# Auto-generated by Flux CLSI (Overleaf Parity)',
      `$biber = 'biber %O %S';`,
      `$bibtex = 'bibtex %O %B';`,
    ];

    // Zero-trust compile sandbox: shell-escape is strictly disabled across all engines
    const shellEscapeFlag = ' -no-shell-escape';

    if (options.engine === 'xelatex') {
      lines.push(`$pdf_mode = 5;`);
      lines.push(`$xelatex = 'xelatex %O${shellEscapeFlag} %S';`);
    } else if (options.engine === 'lualatex') {
      lines.push(`$pdf_mode = 4;`);
      lines.push(`$lualatex = 'lualatex %O${shellEscapeFlag} %S';`);
    } else if (options.engine === 'latex') {
      lines.push(`$pdf_mode = 3;`);
      lines.push(`$latex = 'latex %O${shellEscapeFlag} %S';`);
    } else {
      lines.push(`$pdf_mode = 1;`);
      lines.push(`$pdflatex = 'pdflatex %O${shellEscapeFlag} %S';`);
    }

    lines.push('$max_repeat = 5;');

    return lines.join('\n') + '\n';
  }

  /**
   * Sanitizes user-supplied .latexmkrc content using a strict declarative allowlist
   * to prevent Perl RCE and shell-escape overrides.
   * Only safe numeric/scalar configuration assignments (`$max_repeat`, `$bibtex_use`,
   * `$clean_ext`, `$out_dir`, `$aux_dir`, `$recorder`, `$silent`, `$quiet`) and
   * comments are permitted; arbitrary Perl code or command overrides are rejected.
   */
  public static sanitizeUserLatexmkrc(raw: string): string {
    const safeScalarIntPattern =
      /^\s*\$(?:max_repeat|bibtex_use|recorder|silent|quiet|preview_mode|view)\s*=\s*[0-9]+\s*;\s*(?:#.*)?$/;
    const safeCleanExtPattern =
      /^\s*\$clean_ext\s*=\s*['"][a-zA-Z0-9_.\s%-]*['"]\s*;\s*(?:#.*)?$/;
    const safeUsePragmaPattern =
      /^\s*use\s+(?:strict|warnings|utf8)\s*;\s*(?:#.*)?$/;

    return raw
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return true;
        return (
          safeScalarIntPattern.test(trimmed) ||
          safeCleanExtPattern.test(trimmed) ||
          safeUsePragmaPattern.test(trimmed)
        );
      })
      .join('\n')
      .trim();
  }

  public static async writeLatexmkrc(
    scratchDir: string,
    options: LatexmkrcOptions,
    userCustomContent?: string,
  ): Promise<string> {
    const filePath = path.join(scratchDir, '.latexmkrc');
    const securityConfig = this.generateLatexmkrc(options);
    let content = securityConfig;
    if (userCustomContent && userCustomContent.trim().length > 0) {
      const sanitized = this.sanitizeUserLatexmkrc(userCustomContent);
      if (sanitized.length > 0) {
        // Place user-defined safe settings BEFORE Flux's mandatory security compiler overrides
        // so user configuration can never override $pdflatex/$xelatex/$lualatex/-no-shell-escape.
        content = `# --- User-Defined .latexmkrc (Allowlisted) ---\n${sanitized}\n\n${securityConfig}`;
      }
    }
    await fs.writeFile(filePath, content, 'utf8');
    return filePath;
  }
}
