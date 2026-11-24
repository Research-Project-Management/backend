/**
 * diagnostics/core/domain/value-objects/log-line.ts
 * Value Object for processing TeX log lines, unwrapping 79/80-char line breaks,
 * and normalizing carriage returns.
 */

export class LogLineVo {
  private static readonly TEX_LINE_WRAP_LENGTH = 79;
  private static readonly FRESH_RECORD_START_REGEX =
    /^(?:!|l\.\d+|LaTeX(?: Font)? Warning:|Package [\w-]+ Warning:|Class [\w-]+ Warning:|(?:Over|Under)full \\(?:h|v)box|Runaway argument|(?:[a-zA-Z]:[\\/])?(?:\.{0,2}[\\/])?[^\s:!()]+\.(?:tex|bib|sty|cls|dtx|ins):\d+:)/;

  /**
   * TeX engines hard-wrap log lines at 79 characters.
   * Recombines wrapped lines back into logical lines before parsing the TeX paren tree,
   * while preserving lines ending with '...' and stopping on fresh diagnostic headers.
   */
  public static unwrap(rawLog: string): string[] {
    const rawLines = rawLog
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n');
    if (rawLines.length === 0) return [];

    const unwrapped: string[] = [];
    for (let i = 0; i < rawLines.length; i++) {
      let current = rawLines[i] ?? '';
      let prevRaw = current;

      while (
        prevRaw.length === this.TEX_LINE_WRAP_LENGTH &&
        !prevRaw.endsWith('...') &&
        i + 1 < rawLines.length
      ) {
        const nextRaw = rawLines[i + 1] ?? '';
        if (!nextRaw || this.FRESH_RECORD_START_REGEX.test(nextRaw)) {
          break;
        }
        i++;
        current += nextRaw;
        prevRaw = nextRaw;
      }

      unwrapped.push(current);
    }

    return unwrapped;
  }
}
