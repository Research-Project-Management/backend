/**
 * modules/manuscripts/clsi/domain/draft-mode.manager.ts
 * Manages rapid compilation modes for academic papers:
 * 1. Visual Draft: Injects \PassOptionsToPackage{draft}{graphicx} so layout, text,
 *    citations, and equations render in < 1 second by replacing heavy graphics with bounding boxes.
 * 2. Syntax-Only Draft: Informs engines to skip PDF generation entirely when checking errors.
 * 3. Package requirements: Detects if packages like 'minted' require -shell-escape.
 */

export interface DraftModeApplication {
  source: string;
  isModified: boolean;
  engineFlags: string[];
}

export class DraftModeManager {
  private static readonly GRAPHICX_DRAFT_INJECTION =
    '\\PassOptionsToPackage{draft}{graphicx} % Injected by Flux CLSI Draft Mode\n';

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

  /**
   * @deprecated Advisory only. Never used to enable compiler flags or shell escape.
   */
  public static requiresShellEscape(source: string): boolean {
    return this.detectShellEscapeUsage(source).length > 0;
  }
}
