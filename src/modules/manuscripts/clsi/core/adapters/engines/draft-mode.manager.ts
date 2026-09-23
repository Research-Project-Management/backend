/**
 * modules/manuscripts/clsi/core/adapters/engines/draft-mode.manager.ts
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

  /**
   * Transforms TeX source for rapid draft compilation if enabled.
   */
  public static apply(
    source: string,
    options?: { draft?: boolean; syntaxOnly?: boolean }
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
      // Check if draft option is already configured
      if (
        source.includes('\\PassOptionsToPackage{draft}{graphicx}') ||
        /\\documentclass\[[^\]]*draft[^\]]*\]/i.test(source)
      ) {
        return { source, isModified: false, engineFlags };
      }

      // Inject before \documentclass
      const docClassIndex = source.search(/\\documentclass/i);
      if (docClassIndex !== -1) {
        const transformed =
          source.slice(0, docClassIndex) +
          this.GRAPHICX_DRAFT_INJECTION +
          source.slice(docClassIndex);
        return { source: transformed, isModified: true, engineFlags };
      }

      // Fallback: Prepend at the beginning
      return {
        source: this.GRAPHICX_DRAFT_INJECTION + source,
        isModified: true,
        engineFlags,
      };
    }

    return { source, isModified: false, engineFlags };
  }

  /**
   * Detects if the source uses packages that require -shell-escape (e.g. minted, pythontex).
   */
  public static requiresShellEscape(source: string): boolean {
    if (!source) return false;
    return (
      /\\usepackage(?:\[[^\]]*\])?\{minted\}/i.test(source) ||
      /\\usepackage(?:\[[^\]]*\])?\{pythontex\}/i.test(source)
    );
  }
}
