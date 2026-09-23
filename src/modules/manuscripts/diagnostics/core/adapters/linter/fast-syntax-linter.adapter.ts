/**
 * diagnostics/core/adapters/linter/fast-syntax-linter.adapter.ts
 * Fast in-memory static syntax linter for LaTeX documents.
 * Catches syntax errors (unbalanced braces, unclosed environments, naked math symbols, smart quotes)
 * instantly without requiring a compiler invocation.
 */

import { ISyntaxLinterPort } from '../../ports/syntax-linter.port';
import { DiagnosticItem } from '../../domain/entities/diagnostic-item.entity';
import { DiagnosticSeverityVo } from '../../domain/value-objects/diagnostic-severity.vo';
import { IErrorExplainerPort } from '../../ports/error-explainer.port';

const MATH_ENVIRONMENTS = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'gather',
  'gather*',
  'multline',
  'multline*',
  'flalign',
  'flalign*',
  'array',
  'matrix',
  'pmatrix',
  'bmatrix',
  'vmatrix',
  'Vmatrix',
  'split',
  'cases',
]);

const TABLE_ENVIRONMENTS = new Set([
  'tabular',
  'tabular*',
  'tabularx',
  'tabulary',
  'longtable',
  'array',
  'matrix',
  'pmatrix',
  'bmatrix',
  'vmatrix',
  'align',
  'align*',
  'split',
  'cases',
]);

export class FastSyntaxLinterAdapter implements ISyntaxLinterPort {
  constructor(private readonly explainer?: IErrorExplainerPort) {}

  public lint(source: string, filename = 'main.tex'): DiagnosticItem[] {
    const diagnostics: DiagnosticItem[] = [];
    const lines = source.split('\n');

    const envStack: Array<{ name: string; line: number }> = [];
    const braceStack: Array<{ line: number; col: number }> = [];
    let inInlineMath = false;
    let inlineMathStartLine = 1;
    let inDisplayMathBracket = false;
    let inDisplayMathDollar = false;
    let displayMathStartLine = 1;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const lineNum = lineIdx + 1;
      const rawLine = lines[lineIdx] || '';

      // Strip comments (from unescaped % to end of line)
      const codeOnly = this.stripComment(rawLine);

      // 1. Check for Unicode curly quotes (causes pdfTeX failures)
      if (/[“”‘’]/.test(codeOnly)) {
        diagnostics.push(
          new DiagnosticItem({
            file: filename,
            line: lineNum,
            severity: DiagnosticSeverityVo.warning(),
            message:
              'Phát hiện dấu nháy thông minh (Unicode Smart Quotes: “” hoặc ‘’). pdfTeX có thể không hiển thị được ký tự này.',
            context: rawLine.trim(),
            code: 'SMART_QUOTES',
            explanation: this.explainer?.getByCode('UNDEFINED_CONTROL_SEQUENCE') || undefined,
          })
        );
      }

      // Scan character by character
      let i = 0;
      while (i < codeOnly.length) {
        const char = codeOnly[i];
        const nextChar = i + 1 < codeOnly.length ? codeOnly[i + 1] : '';

        // Escaped character (e.g. \{, \}, \$, \%, \_, \&)
        if (char === '\\') {
          // Check for display math \[ and \]
          if (nextChar === '[') {
            inDisplayMathBracket = true;
            displayMathStartLine = lineNum;
            i += 2;
            continue;
          }
          if (nextChar === ']') {
            inDisplayMathBracket = false;
            i += 2;
            continue;
          }

          // Check for \begin{env}
          const beginMatch = codeOnly.slice(i).match(/^\\begin\{([^}]+)\}/);
          if (beginMatch && beginMatch[1]) {
            envStack.push({ name: beginMatch[1].trim(), line: lineNum });
            i += beginMatch[0].length;
            continue;
          }

          // Check for \end{env}
          const endMatch = codeOnly.slice(i).match(/^\\end\{([^}]+)\}/);
          if (endMatch && endMatch[1]) {
            const endEnvName = endMatch[1].trim();
            const matchIdx = envStack.map((e) => e.name).lastIndexOf(endEnvName);

            if (matchIdx !== -1) {
              // Found matching environment in stack - all environments above it were unclosed
              while (envStack.length - 1 > matchIdx) {
                const unclosed = envStack.pop()!;
                diagnostics.push(
                  new DiagnosticItem({
                    file: filename,
                    line: unclosed.line,
                    severity: DiagnosticSeverityVo.error(),
                    message: `Môi trường \\begin{${unclosed.name}} tại dòng ${unclosed.line} chưa có \\end{${unclosed.name}} tương ứng trước khi kết thúc tệp.`,
                    code: 'UNCLOSED_ENVIRONMENT',
                    explanation: this.explainer?.getByCode('ENVIRONMENT_MISMATCH') || undefined,
                  })
                );
              }
              // Pop the matched environment itself
              envStack.pop();
            } else if (envStack.length > 0) {
              // Mismatch with immediate top environment
              const top = envStack.pop()!;
              diagnostics.push(
                new DiagnosticItem({
                  file: filename,
                  line: lineNum,
                  severity: DiagnosticSeverityVo.error(),
                  message: `Môi trường \\begin{${top.name}} (tại dòng ${top.line}) bị đóng sai bằng \\end{${endEnvName}}.`,
                  context: rawLine.trim(),
                  code: 'ENVIRONMENT_MISMATCH',
                  explanation: this.explainer?.getByCode('ENVIRONMENT_MISMATCH') || undefined,
                })
              );
            } else {
              diagnostics.push(
                new DiagnosticItem({
                  file: filename,
                  line: lineNum,
                  severity: DiagnosticSeverityVo.error(),
                  message: `Thừa lệnh \\end{${endEnvName}} mà không có \\begin tương ứng.`,
                  context: rawLine.trim(),
                  code: 'UNMATCHED_END_ENVIRONMENT',
                  explanation: this.explainer?.getByCode('ENVIRONMENT_MISMATCH') || undefined,
                })
              );
            }
            i += endMatch[0].length;
            continue;
          }

          // Any other escaped char: skip it and next char
          i += 2;
          continue;
        }

        // Display math $$ ... $$
        if (char === '$' && nextChar === '$') {
          inDisplayMathDollar = !inDisplayMathDollar;
          if (inDisplayMathDollar) displayMathStartLine = lineNum;
          i += 2;
          continue;
        }

        // Single inline math $ ... $
        if (char === '$') {
          inInlineMath = !inInlineMath;
          if (inInlineMath) inlineMathStartLine = lineNum;
          i++;
          continue;
        }

        // Braces balance
        if (char === '{') {
          braceStack.push({ line: lineNum, col: i + 1 });
        } else if (char === '}') {
          if (braceStack.length === 0) {
            diagnostics.push(
              new DiagnosticItem({
                file: filename,
                line: lineNum,
                column: i + 1,
                severity: DiagnosticSeverityVo.error(),
                message: 'Thừa dấu ngoặc nhọn đóng "}" không có dấu mở tương ứng.',
                context: rawLine.trim(),
                code: 'UNBALANCED_BRACES',
                explanation: this.explainer?.getByCode('UNBALANCED_BRACES') || undefined,
              })
            );
          } else {
            braceStack.pop();
          }
        }

        // Naked math operators (_ or ^) outside math mode
        const isCurrentInMath =
          inInlineMath ||
          inDisplayMathBracket ||
          inDisplayMathDollar ||
          (envStack.length > 0 && MATH_ENVIRONMENTS.has(envStack[envStack.length - 1]!.name));

        if (!isCurrentInMath) {
          if (char === '_' || char === '^') {
            diagnostics.push(
              new DiagnosticItem({
                file: filename,
                line: lineNum,
                column: i + 1,
                severity: DiagnosticSeverityVo.error(),
                message: `Ký tự toán học "${char}" nằm ngoài môi trường toán học. Hãy dùng $...$ hoặc escape "\\${char}".`,
                context: rawLine.trim(),
                code: 'MISSING_MATH_DELIMITER',
                explanation: this.explainer?.getByCode('MISSING_MATH_DELIMITER') || undefined,
              })
            );
          }

          // Naked & outside tables or align environments
          if (char === '&') {
            const isCurrentInTable =
              envStack.length > 0 && TABLE_ENVIRONMENTS.has(envStack[envStack.length - 1]!.name);
            if (!isCurrentInTable) {
              diagnostics.push(
                new DiagnosticItem({
                  file: filename,
                  line: lineNum,
                  column: i + 1,
                  severity: DiagnosticSeverityVo.error(),
                  message:
                    'Ký tự phân cách cột "&" nằm ngoài môi trường bảng (tabular). Nếu là văn bản thường, hãy viết "\\&".',
                  context: rawLine.trim(),
                  code: 'EXTRA_ALIGNMENT_TAB',
                  explanation: this.explainer?.getByCode('EXTRA_ALIGNMENT_TAB') || undefined,
                })
              );
            }
          }
        }

        i++;
      }
    }

    // Check remaining unclosed braces
    while (braceStack.length > 0) {
      const unclosed = braceStack.pop()!;
      diagnostics.push(
        new DiagnosticItem({
          file: filename,
          line: unclosed.line,
          column: unclosed.col,
          severity: DiagnosticSeverityVo.error(),
          message: `Dấu ngoặc nhọn mở "{" tại dòng ${unclosed.line} chưa được đóng bằng "}".`,
          code: 'UNBALANCED_BRACES',
          explanation: this.explainer?.getByCode('UNBALANCED_BRACES') || undefined,
        })
      );
    }

    // Check remaining unclosed environments
    while (envStack.length > 0) {
      const unclosed = envStack.pop()!;
      diagnostics.push(
        new DiagnosticItem({
          file: filename,
          line: unclosed.line,
          severity: DiagnosticSeverityVo.error(),
          message: `Môi trường \\begin{${unclosed.name}} tại dòng ${unclosed.line} chưa có \\end{${unclosed.name}} tương ứng trước khi kết thúc tệp.`,
          code: 'UNCLOSED_ENVIRONMENT',
          explanation: this.explainer?.getByCode('ENVIRONMENT_MISMATCH') || undefined,
        })
      );
    }

    // Check unclosed display math
    if (inDisplayMathBracket) {
      diagnostics.push(
        new DiagnosticItem({
          file: filename,
          line: displayMathStartLine,
          severity: DiagnosticSeverityVo.error(),
          message: `Khối toán học \\[ mở tại dòng ${displayMathStartLine} chưa được đóng bằng \\].`,
          code: 'MISSING_MATH_DELIMITER',
          explanation: this.explainer?.getByCode('MISSING_MATH_DELIMITER') || undefined,
        })
      );
    }

    if (inDisplayMathDollar) {
      diagnostics.push(
        new DiagnosticItem({
          file: filename,
          line: displayMathStartLine,
          severity: DiagnosticSeverityVo.error(),
          message: `Khối toán học $$ mở tại dòng ${displayMathStartLine} chưa được đóng bằng $$.`,
          code: 'MISSING_MATH_DELIMITER',
          explanation: this.explainer?.getByCode('MISSING_MATH_DELIMITER') || undefined,
        })
      );
    }

    if (inInlineMath) {
      diagnostics.push(
        new DiagnosticItem({
          file: filename,
          line: inlineMathStartLine,
          severity: DiagnosticSeverityVo.error(),
          message: `Công thức toán inline $ mở tại dòng ${inlineMathStartLine} chưa được đóng bằng $.`,
          code: 'MISSING_MATH_DELIMITER',
          explanation: this.explainer?.getByCode('MISSING_MATH_DELIMITER') || undefined,
        })
      );
    }

    return diagnostics;
  }

  private stripComment(line: string): string {
    let result = '';
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) {
        break; // comment starts here
      }
      result += line[i];
    }
    return result;
  }
}
