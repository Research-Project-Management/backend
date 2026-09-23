/**
 * modules/manuscripts/clsi/core/adapters/artifacts/latex-log.parser.ts
 * Parses TeX compilation logs into structured diagnostics (errors, warnings, badboxes)
 * with precise file and line associations.
 */

import {
  CompilerDiagnostic,
  ILogParser,
} from '../../ports/artifacts.port';

export class OverleafLogParser implements ILogParser {
  private static readonly LATEX_WARNING_REGEX =
    /(?:LaTeX|Package \w+|Class \w+)\s+Warning:\s*(.+?)(?:on input line\s+(\d+)\.|\.)/i;

  private static readonly BADBOX_REGEX =
    /(?:Overfull|Underfull)\s+\\(?:hbox|vbox)\s*\([^)]*\)\s*(?:in paragraph\s*)?at lines?\s+(\d+)(?:--\d+)?/i;

  private static readonly TECTONIC_ERROR_REGEX =
    /^error:\s+(?:([^:]+):)?(\d+):\s+(.+)/i;

  public parse(
    logText: string,
    defaultFile = 'main.tex'
  ): CompilerDiagnostic[] {
    const diagnostics: CompilerDiagnostic[] = [];
    const lines = logText.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;

      // 1. Tectonic CLI errors (error: file:line: message)
      const tectonicMatch = line.match(OverleafLogParser.TECTONIC_ERROR_REGEX);
      if (tectonicMatch && tectonicMatch[3]) {
        const errorFile = tectonicMatch[1]?.trim() || defaultFile;
        const errorLine = parseInt(tectonicMatch[2]!, 10);
        const message = tectonicMatch[3].trim();
        const context = lines
          .slice(i, Math.min(i + 3, lines.length))
          .join('\n');
        const { code, suggestion } = this.generateSuggestion(message, context);

        diagnostics.push({
          file: errorFile,
          line: errorLine,
          message,
          context,
          severity: 'error',
          code,
          suggestion,
        });
        continue;
      }

      // 2. Standard TeX critical errors (! LaTeX Error: ...)
      if (line.startsWith('!')) {
        const message = line.slice(1).trim();
        let errorLine: number | null = null;
        let context = '';

        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const match = lines[j]?.match(/^l\.(\d+)/);
          if (match && match[1]) {
            errorLine = parseInt(match[1], 10);
            context = lines.slice(i, j + 2).join('\n');
            break;
          }
        }

        const resolvedContext = context || lines.slice(i, i + 3).join('\n');
        const { code, suggestion } = this.generateSuggestion(
          message,
          resolvedContext
        );

        diagnostics.push({
          file: defaultFile,
          line: errorLine,
          message,
          context: resolvedContext,
          severity: 'error',
          code,
          suggestion,
        });
        continue;
      }

      // 3. LaTeX Package / Class Warnings
      const warningMatch = line.match(OverleafLogParser.LATEX_WARNING_REGEX);
      if (warningMatch && warningMatch[1]) {
        const message = warningMatch[1].trim();
        const lineNum = warningMatch[2] ? parseInt(warningMatch[2], 10) : null;

        diagnostics.push({
          file: defaultFile,
          line: lineNum,
          message: `LaTeX Warning: ${message}`,
          context: line,
          severity: 'warning',
        });
        continue;
      }

      // 4. Badboxes (Overfull / Underfull \hbox or \vbox)
      const badboxMatch = line.match(OverleafLogParser.BADBOX_REGEX);
      if (badboxMatch && badboxMatch[1]) {
        const lineNum = parseInt(badboxMatch[1], 10);
        diagnostics.push({
          file: defaultFile,
          line: lineNum,
          message: line.trim(),
          context: line,
          severity: 'info',
        });
      }
    }

    return diagnostics;
  }

  private generateSuggestion(
    message: string,
    context: string
  ): { code?: string; suggestion?: string } {
    const lowerMsg = message.toLowerCase();

    if (lowerMsg.includes('undefined control sequence')) {
      const match = context.match(/\\([a-zA-Z]+)/);
      const command = match ? `\\${match[1]}` : 'cụm từ điều khiển này';
      return {
        code: 'UNDEFINED_MACRO',
        suggestion: `Lệnh "${command}" chưa được định nghĩa. Kiểm tra lại chính tả hoặc thêm \\usepackage{...} cần thiết.`,
      };
    }

    if (lowerMsg.includes('missing $ inserted')) {
      return {
        code: 'MISSING_MATH_DELIMITER',
        suggestion:
          'Ký tự toán học hoặc biến số cần được đặt trong môi trường toán ($...$ hoặc \\[...\\]).',
      };
    }

    if (lowerMsg.includes('file') && lowerMsg.includes('not found')) {
      return {
        code: 'FILE_NOT_FOUND',
        suggestion:
          'Không tìm thấy tệp ảnh, bibliography hoặc package được gọi. Kiểm tra lại đường dẫn tệp.',
      };
    }

    return {};
  }
}
