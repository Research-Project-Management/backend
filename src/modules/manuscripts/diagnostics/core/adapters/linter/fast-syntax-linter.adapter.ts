/**
 * diagnostics/core/adapters/linter/fast-syntax-linter.adapter.ts
 * Fast in-memory static syntax linter & pre-compile auto-fixer for LaTeX documents.
 * Catches syntax errors (unbalanced braces, unclosed environments, naked math symbols, smart quotes,
 * missing bibliography citation keys) instantly without requiring a compiler invocation.
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

const VERBATIM_ENVIRONMENTS = new Set([
  'verbatim',
  'verbatim*',
  'lstlisting',
  'minted',
  'filecontents',
  'filecontents*',
]);

export interface AppliedFix {
  line: number;
  rule: string;
  description: string;
}

export interface AutoFixResult {
  isFixed: boolean;
  fixedSource: string;
  appliedFixes: AppliedFix[];
}

interface MathScanState {
  inInlineMath: boolean;
  inlineMathStartLine: number;
  inDisplayMathBracket: boolean;
  inDisplayMathDollar: boolean;
  displayMathStartLine: number;
}

export class FastSyntaxLinterAdapter implements ISyntaxLinterPort {
  constructor(private readonly explainer?: IErrorExplainerPort) {}

  public lint(
    source: string,
    filename = 'main.tex',
    knownBibKeys?: Set<string>,
  ): DiagnosticItem[] {
    const diagnostics: DiagnosticItem[] = [];
    const lines = source.split('\n');

    const envStack: Array<{ name: string; line: number }> = [];
    const braceStack: Array<{ line: number; col: number }> = [];
    const mathState: MathScanState = {
      inInlineMath: false,
      inlineMathStartLine: 1,
      inDisplayMathBracket: false,
      inDisplayMathDollar: false,
      displayMathStartLine: 1,
    };

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const lineNum = lineIdx + 1;
      const rawLine = lines[lineIdx] || '';

      if (this.isLineInVerbatim(rawLine, envStack)) {
        continue;
      }

      const codeOnly = this.stripComment(rawLine);

      // 1. Check for Unicode curly quotes (causes pdfTeX failures)
      this.lintSmartQuotes(codeOnly, rawLine, lineNum, filename, diagnostics);

      // 2. Check for missing citation keys against project .bib files
      this.lintCitationKeys(
        codeOnly,
        rawLine,
        lineNum,
        filename,
        knownBibKeys,
        diagnostics,
      );

      // 3. Scan character by character for environments, math delimiters, and braces
      this.scanLineCharacters(
        codeOnly,
        rawLine,
        lineNum,
        filename,
        envStack,
        braceStack,
        mathState,
        diagnostics,
      );
    }

    // 4. Post-scan unclosed structures
    this.lintUnclosedBraces(braceStack, filename, diagnostics);
    this.lintUnclosedEnvironments(envStack, filename, diagnostics);
    this.lintUnclosedMath(mathState, filename, diagnostics);

    return diagnostics;
  }

  /**
   * Automatically repairs syntax errors in LaTeX source:
   * - Converts Unicode smart quotes to standard LaTeX quotes (`` and '').
   * - Escapes naked underscores `_` outside math mode to `\_`.
   * - Escapes naked ampersands `&` outside tabular/align to `\&`.
   * - Escapes literal percent signs preceded by numbers (e.g. 50% -> 50\%) in text.
   * - Appends missing \end{env} tags at the end of the document.
   */
  public autoFix(source: string): AutoFixResult {
    const lines = source.split('\n');
    const appliedFixes: AppliedFix[] = [];
    const fixedLines: string[] = [];
    const unclosedEnvs: string[] = [];

    let inVerbatim = false;

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i] || '';
      const lineNum = i + 1;

      if (this.isVerbatimStart(line)) {
        inVerbatim = true;
      }
      if (inVerbatim) {
        fixedLines.push(line);
        if (this.isVerbatimEnd(line)) {
          inVerbatim = false;
        }
        continue;
      }

      // Track unclosed environments
      this.trackEnvironmentsForAutoFix(line, unclosedEnvs);

      // 1. Fix Unicode Smart Quotes
      line = this.fixSmartQuotes(line, lineNum, appliedFixes);

      // 2. Fix naked percentage signs in text (e.g., "95% accuracy" -> "95\% accuracy")
      line = this.fixNakedPercentages(line, lineNum, appliedFixes);

      // 3. Fix naked underscore outside math mode
      line = this.fixNakedUnderscores(line, lineNum, appliedFixes);

      fixedLines.push(line);
    }

    // 4. Close any remaining unclosed environments at end of document
    this.fixRemainingUnclosedEnvironments(
      unclosedEnvs,
      fixedLines,
      appliedFixes,
    );

    return {
      isFixed: appliedFixes.length > 0,
      fixedSource: fixedLines.join('\n'),
      appliedFixes,
    };
  }

  // =========================================================================
  // PRIVATE LINT HELPERS
  // =========================================================================

  private isLineInVerbatim(
    rawLine: string,
    envStack: Array<{ name: string; line: number }>,
  ): boolean {
    const currentEnv =
      envStack.length > 0 ? envStack[envStack.length - 1].name : null;
    const inVerbatim =
      currentEnv !== null && VERBATIM_ENVIRONMENTS.has(currentEnv);

    if (inVerbatim) {
      const endMatch = rawLine.match(/\\end\{([^}]+)\}/);
      if (
        endMatch &&
        endMatch[1] &&
        VERBATIM_ENVIRONMENTS.has(endMatch[1].trim())
      ) {
        envStack.pop();
      }
      return true;
    }
    return false;
  }

  private lintSmartQuotes(
    codeOnly: string,
    rawLine: string,
    lineNum: number,
    filename: string,
    diagnostics: DiagnosticItem[],
  ): void {
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
          explanation:
            this.explainer?.getByCode('UNDEFINED_CONTROL_SEQUENCE') ||
            undefined,
          quickFix: {
            description:
              "Chuyển đổi dấu nháy Unicode thành dấu nháy chuẩn LaTeX (`` hoặc '')",
            replacementText: rawLine
              .replace(/“/g, '``')
              .replace(/”/g, "''")
              .replace(/‘/g, '`')
              .replace(/’/g, "'"),
          },
        }),
      );
    }
  }

  private lintCitationKeys(
    codeOnly: string,
    rawLine: string,
    lineNum: number,
    filename: string,
    knownBibKeys: Set<string> | undefined,
    diagnostics: DiagnosticItem[],
  ): void {
    if (!knownBibKeys || knownBibKeys.size === 0) return;

    const citeMatches = codeOnly.matchAll(
      /\\(?:cite|citep|citet|parencite|footcite|nocite|citeauthor|citeyear)\{([^}]+)\}/g,
    );
    for (const m of citeMatches) {
      if (m[1]) {
        const keys = m[1].split(',').map((k) => k.trim());
        for (const key of keys) {
          if (key && !knownBibKeys.has(key)) {
            diagnostics.push(
              new DiagnosticItem({
                file: filename,
                line: lineNum,
                severity: DiagnosticSeverityVo.warning(),
                message: `Khóa trích dẫn "${key}" không tồn tại trong danh mục tài liệu tham khảo (.bib) của dự án.`,
                context: rawLine.trim(),
                code: 'MISSING_CITATION_KEY',
                explanation:
                  this.explainer?.getByCode('UNDEFINED_CITATION') || undefined,
                quickFix: {
                  description: `Thêm mục trích dẫn @article{${key}, ...} vào references.bib`,
                  replacementText: key,
                },
              }),
            );
          }
        }
      }
    }
  }

  private scanLineCharacters(
    codeOnly: string,
    rawLine: string,
    lineNum: number,
    filename: string,
    envStack: Array<{ name: string; line: number }>,
    braceStack: Array<{ line: number; col: number }>,
    mathState: MathScanState,
    diagnostics: DiagnosticItem[],
  ): void {
    let i = 0;
    while (i < codeOnly.length) {
      const char = codeOnly[i];
      const nextChar = i + 1 < codeOnly.length ? codeOnly[i + 1] : '';

      // Escaped character (e.g. \{, \}, \$, \%, \_, \&, \#, \[, \])
      if (char === '\\') {
        if (nextChar === '[') {
          mathState.inDisplayMathBracket = true;
          mathState.displayMathStartLine = lineNum;
          i += 2;
          continue;
        }
        if (nextChar === ']') {
          mathState.inDisplayMathBracket = false;
          i += 2;
          continue;
        }

        // Check for \begin{env}
        const beginMatch = codeOnly.slice(i).match(/^\\begin\{([^}]+)\}/);
        if (beginMatch && beginMatch[1]) {
          const envName = beginMatch[1].trim();
          envStack.push({ name: envName, line: lineNum });
          i += beginMatch[0].length;
          continue;
        }

        // Check for \end{env}
        const endMatch = codeOnly.slice(i).match(/^\\end\{([^}]+)\}/);
        if (endMatch && endMatch[1]) {
          this.handleEndEnvironment(
            endMatch[1].trim(),
            rawLine,
            lineNum,
            filename,
            envStack,
            diagnostics,
          );
          i += endMatch[0].length;
          continue;
        }

        // Any other escaped char: skip it and next char
        i += 2;
        continue;
      }

      // Display math $$ ... $$
      if (char === '$' && nextChar === '$') {
        mathState.inDisplayMathDollar = !mathState.inDisplayMathDollar;
        if (mathState.inDisplayMathDollar)
          mathState.displayMathStartLine = lineNum;
        i += 2;
        continue;
      }

      // Single inline math $ ... $
      if (char === '$') {
        mathState.inInlineMath = !mathState.inInlineMath;
        if (mathState.inInlineMath) mathState.inlineMathStartLine = lineNum;
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
              message:
                'Thừa dấu ngoặc nhọn đóng "}" không có dấu mở tương ứng.',
              context: rawLine.trim(),
              code: 'UNBALANCED_BRACES',
              explanation:
                this.explainer?.getByCode('UNBALANCED_BRACES') || undefined,
            }),
          );
        } else {
          braceStack.pop();
        }
      }

      // Naked math operators (_ or ^) outside math mode
      const isCurrentInMath =
        mathState.inInlineMath ||
        mathState.inDisplayMathBracket ||
        mathState.inDisplayMathDollar ||
        (envStack.length > 0 &&
          MATH_ENVIRONMENTS.has(envStack[envStack.length - 1].name));

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
              explanation:
                this.explainer?.getByCode('MISSING_MATH_DELIMITER') ||
                undefined,
              quickFix: {
                description: `Escape ký tự "${char}" thành "\\${char}"`,
                replacementText: `\\${char}`,
              },
            }),
          );
        }

        // Naked & outside tables or align environments
        if (char === '&') {
          const isCurrentInTable =
            envStack.length > 0 &&
            TABLE_ENVIRONMENTS.has(envStack[envStack.length - 1].name);
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
                explanation:
                  this.explainer?.getByCode('EXTRA_ALIGNMENT_TAB') || undefined,
                quickFix: {
                  description: 'Escape ký tự & thành \\&',
                  replacementText: '\\&',
                },
              }),
            );
          }
        }
      }

      i++;
    }
  }

  private handleEndEnvironment(
    endEnvName: string,
    rawLine: string,
    lineNum: number,
    filename: string,
    envStack: Array<{ name: string; line: number }>,
    diagnostics: DiagnosticItem[],
  ): void {
    const matchIdx = envStack.map((e) => e.name).lastIndexOf(endEnvName);

    if (matchIdx !== -1) {
      while (envStack.length - 1 > matchIdx) {
        const unclosed = envStack.pop()!;
        diagnostics.push(
          new DiagnosticItem({
            file: filename,
            line: unclosed.line,
            severity: DiagnosticSeverityVo.error(),
            message: `Môi trường \\begin{${unclosed.name}} tại dòng ${unclosed.line} chưa có \\end{${unclosed.name}} tương ứng trước khi kết thúc tệp.`,
            code: 'UNCLOSED_ENVIRONMENT',
            explanation:
              this.explainer?.getByCode('ENVIRONMENT_MISMATCH') || undefined,
            quickFix: {
              description: `Thêm \\end{${unclosed.name}} để đóng môi trường`,
              replacementText: `\\end{${unclosed.name}}`,
            },
          }),
        );
      }
      envStack.pop();
    } else if (envStack.length > 0) {
      const top = envStack.pop()!;
      diagnostics.push(
        new DiagnosticItem({
          file: filename,
          line: lineNum,
          severity: DiagnosticSeverityVo.error(),
          message: `Môi trường \\begin{${top.name}} (tại dòng ${top.line}) bị đóng sai bằng \\end{${endEnvName}}.`,
          context: rawLine.trim(),
          code: 'ENVIRONMENT_MISMATCH',
          explanation:
            this.explainer?.getByCode('ENVIRONMENT_MISMATCH') || undefined,
          quickFix: {
            description: `Sửa thành \\end{${top.name}}`,
            replacementText: `\\end{${top.name}}`,
          },
        }),
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
          explanation:
            this.explainer?.getByCode('ENVIRONMENT_MISMATCH') || undefined,
        }),
      );
    }
  }

  private lintUnclosedBraces(
    braceStack: Array<{ line: number; col: number }>,
    filename: string,
    diagnostics: DiagnosticItem[],
  ): void {
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
          explanation:
            this.explainer?.getByCode('UNBALANCED_BRACES') || undefined,
          quickFix: {
            description: 'Thêm dấu đóng ngoặc nhọn "}"',
            replacementText: '}',
          },
        }),
      );
    }
  }

  private lintUnclosedEnvironments(
    envStack: Array<{ name: string; line: number }>,
    filename: string,
    diagnostics: DiagnosticItem[],
  ): void {
    while (envStack.length > 0) {
      const unclosed = envStack.pop()!;
      diagnostics.push(
        new DiagnosticItem({
          file: filename,
          line: unclosed.line,
          severity: DiagnosticSeverityVo.error(),
          message: `Môi trường \\begin{${unclosed.name}} tại dòng ${unclosed.line} chưa có \\end{${unclosed.name}} tương ứng trước khi kết thúc tệp.`,
          code: 'UNCLOSED_ENVIRONMENT',
          explanation:
            this.explainer?.getByCode('ENVIRONMENT_MISMATCH') || undefined,
          quickFix: {
            description: `Thêm \\end{${unclosed.name}} ở cuối tệp`,
            replacementText: `\\end{${unclosed.name}}`,
          },
        }),
      );
    }
  }

  private lintUnclosedMath(
    mathState: MathScanState,
    filename: string,
    diagnostics: DiagnosticItem[],
  ): void {
    if (mathState.inDisplayMathBracket) {
      diagnostics.push(
        new DiagnosticItem({
          file: filename,
          line: mathState.displayMathStartLine,
          severity: DiagnosticSeverityVo.error(),
          message: `Khối toán học \\[ mở tại dòng ${mathState.displayMathStartLine} chưa được đóng bằng \\].`,
          code: 'MISSING_MATH_DELIMITER',
          explanation:
            this.explainer?.getByCode('MISSING_MATH_DELIMITER') || undefined,
        }),
      );
    }

    if (mathState.inDisplayMathDollar) {
      diagnostics.push(
        new DiagnosticItem({
          file: filename,
          line: mathState.displayMathStartLine,
          severity: DiagnosticSeverityVo.error(),
          message: `Khối toán học $$ mở tại dòng ${mathState.displayMathStartLine} chưa được đóng bằng $$.`,
          code: 'MISSING_MATH_DELIMITER',
          explanation:
            this.explainer?.getByCode('MISSING_MATH_DELIMITER') || undefined,
        }),
      );
    }

    if (mathState.inInlineMath) {
      diagnostics.push(
        new DiagnosticItem({
          file: filename,
          line: mathState.inlineMathStartLine,
          severity: DiagnosticSeverityVo.error(),
          message: `Công thức toán inline $ mở tại dòng ${mathState.inlineMathStartLine} chưa được đóng bằng $.`,
          code: 'MISSING_MATH_DELIMITER',
          explanation:
            this.explainer?.getByCode('MISSING_MATH_DELIMITER') || undefined,
        }),
      );
    }
  }

  // =========================================================================
  // PRIVATE AUTO-FIX HELPERS
  // =========================================================================

  private isVerbatimStart(line: string): boolean {
    return (
      line.includes('\\begin{verbatim}') ||
      line.includes('\\begin{lstlisting}') ||
      line.includes('\\begin{minted}')
    );
  }

  private isVerbatimEnd(line: string): boolean {
    return (
      line.includes('\\end{verbatim}') ||
      line.includes('\\end{lstlisting}') ||
      line.includes('\\end{minted}')
    );
  }

  private trackEnvironmentsForAutoFix(
    line: string,
    unclosedEnvs: string[],
  ): void {
    const beginMatches = line.matchAll(/\\begin\{([^}]+)\}/g);
    for (const m of beginMatches) {
      if (m[1]) unclosedEnvs.push(m[1].trim());
    }
    const endMatches = line.matchAll(/\\end\{([^}]+)\}/g);
    for (const m of endMatches) {
      if (m[1]) {
        const idx = unclosedEnvs.lastIndexOf(m[1].trim());
        if (idx !== -1) unclosedEnvs.splice(idx, 1);
      }
    }
  }

  private fixSmartQuotes(
    line: string,
    lineNum: number,
    appliedFixes: AppliedFix[],
  ): string {
    if (/[“”‘’]/.test(line)) {
      appliedFixes.push({
        line: lineNum,
        rule: 'SMART_QUOTES',
        description:
          'Chuyển đổi dấu nháy Unicode thông minh sang dấu nháy chuẩn LaTeX',
      });
      return line
        .replace(/“/g, '``')
        .replace(/”/g, "''")
        .replace(/‘/g, '`')
        .replace(/’/g, "'");
    }
    return line;
  }

  private fixNakedPercentages(
    line: string,
    lineNum: number,
    appliedFixes: AppliedFix[],
  ): string {
    const percentFix = line.replace(/(\d+)\s*%(?![a-zA-Z\s]*$)/g, '$1\\%');
    if (percentFix !== line) {
      appliedFixes.push({
        line: lineNum,
        rule: 'UNESCAPED_PERCENT',
        description: 'Thêm dấu escape \\% cho ký tự phần trăm trong câu văn',
      });
      return percentFix;
    }
    return line;
  }

  private fixNakedUnderscores(
    line: string,
    lineNum: number,
    appliedFixes: AppliedFix[],
  ): string {
    let fixedChars = '';
    let isMathChar = false;
    let underscoreFixed = false;

    for (let cIdx = 0; cIdx < line.length; cIdx++) {
      const c = line[cIdx];
      const prevC = cIdx > 0 ? line[cIdx - 1] : '';
      if (c === '$') {
        isMathChar = !isMathChar;
      }
      if (c === '_' && !isMathChar && prevC !== '\\') {
        fixedChars += '\\_';
        underscoreFixed = true;
      } else {
        fixedChars += c;
      }
    }

    if (underscoreFixed) {
      appliedFixes.push({
        line: lineNum,
        rule: 'NAKED_UNDERSCORE',
        description: 'Escape ký tự gạch dưới "_" thành "\\_"',
      });
      return fixedChars;
    }
    return line;
  }

  private fixRemainingUnclosedEnvironments(
    unclosedEnvs: string[],
    fixedLines: string[],
    appliedFixes: AppliedFix[],
  ): void {
    while (unclosedEnvs.length > 0) {
      const env = unclosedEnvs.pop()!;
      fixedLines.push(`\\end{${env}}`);
      appliedFixes.push({
        line: fixedLines.length,
        rule: 'UNCLOSED_ENVIRONMENT',
        description: `Tự động bổ sung \\end{${env}} bị thiếu ở cuối tài liệu`,
      });
    }
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
