/**
 * diagnostics/core/domain/value-objects/log-line.vo.ts
 * Value Object for processing TeX log lines, unwrapping 79/80-char line breaks,
 * and normalizing carriage returns.
 */

export class LogLineVo {
  private static readonly TEX_LINE_MAX_LENGTH = 79;

  /**
   * TeX engines hard-wrap log lines at 79 or 80 characters.
   * This method recombines wrapped lines back into single logical lines
   * before parsing the TeX parentheses tree or error headers.
   */
  public static unwrap(rawLog: string): string[] {
    const rawLines = rawLog.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const unwrapped: string[] = [];

    for (let i = 0; i < rawLines.length; i++) {
      let current = rawLines[i] || '';

      // Check if current line was wrapped by TeX:
      // Current line length is >= 79 and next line continues without marker
      while (
        rawLines[i] &&
        rawLines[i]!.length >= this.TEX_LINE_MAX_LENGTH &&
        i + 1 < rawLines.length &&
        rawLines[i + 1] &&
        !rawLines[i + 1]!.startsWith('!') &&
        !rawLines[i + 1]!.startsWith('l.') &&
        !rawLines[i + 1]!.startsWith('(') &&
        !rawLines[i + 1]!.startsWith('LaTeX Warning:')
      ) {
        i++;
        current += rawLines[i];
      }

      unwrapped.push(current);
    }

    return unwrapped;
  }
}
