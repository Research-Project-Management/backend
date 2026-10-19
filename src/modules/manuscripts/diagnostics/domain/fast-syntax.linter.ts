/**
 * modules/manuscripts/diagnostics/domain/fast-syntax.linter.ts
 * Pure domain static syntax linter & pre-compile auto-fixer for LaTeX documents.
 * Zero I/O, zero NestJS imports.
 */

import { DiagnosticItem, DiagnosticSeverityVo } from './diagnostic-item.entity';
import { DiagnosticReport } from './diagnostic-report.entity';
import { ErrorExplainerLike, ErrorKnowledgeBase } from './compile-log.analyzer';

const MATH_ENVIRONMENTS = new Set([
  'equation',
  'equation*',
  'align',
  'align*',
  'alignat',
  'alignat*',
  'aligned',
  'alignedat',
  'gather',
  'gather*',
  'gathered',
  'multline',
  'multline*',
  'flalign',
  'flalign*',
  'eqnarray',
  'eqnarray*',
  'math',
  'displaymath',
  'array',
  'matrix',
  'pmatrix',
  'bmatrix',
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'smallmatrix',
  'subarray',
  'split',
  'cases',
  'tikzpicture',
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
  'Bmatrix',
  'vmatrix',
  'Vmatrix',
  'smallmatrix',
  'align',
  'align*',
  'alignat',
  'alignat*',
  'aligned',
  'alignedat',
  'flalign',
  'flalign*',
  'eqnarray',
  'eqnarray*',
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
  'comment',
]);

const TECHNICAL_COMMAND_REGEX =
  /\\(?:label|ref|eqref|pageref|autoref|nameref|cref|Cref|cite[a-zA-Z]*|newcite|shortcite|parencite|footcite|textcite|smartcite|autocite|nocite|input|include|subfile|includegraphics|bibliography|bibliographystyle|addbibresource|usepackage|documentclass|url|href|path|texttt|newcommand|renewcommand|providecommand|DeclareMathOperator|definecolor|color|textcolor)\*?(?:\[[^\]]*\])*\{([^{}]*)\}/g;

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
  inInlineMathParen: boolean;
  inlineMathStartLine: number;
  inDisplayMathBracket: boolean;
  inDisplayMathDollar: boolean;
  displayMathStartLine: number;
}

export class FastSyntaxLinter {
  private readonly explainer?: ErrorExplainerLike;

  constructor(explainer?: ErrorExplainerLike) {
    this.explainer = explainer ?? new ErrorKnowledgeBase();
  }

  public lintToReport(
    source: string,
    filename = 'main.tex',
    knownBibKeys?: Set<string>,
  ): DiagnosticReport {
    const items = this.lint(source ?? '', filename || 'main.tex', knownBibKeys);
    return new DiagnosticReport({
      items,
      rawLog: undefined,
    });
  }

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
      inInlineMathParen: false,
      inlineMathStartLine: 1,
      inDisplayMathBracket: false,
      inDisplayMathDollar: false,
      displayMathStartLine: 1,
    };

    let ifFalseDepth = 0;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const lineNum = lineIdx + 1;
      const rawLine = lines[lineIdx] || '';

      if (this.isLineInVerbatim(rawLine, envStack)) {
        continue;
      }

      const codeOnly = this.stripComment(rawLine);

      if (/\\iffalse\b/.test(codeOnly)) {
        ifFalseDepth++;
      }
      if (ifFalseDepth > 0) {
        if (/\\fi\b/.test(codeOnly)) {
          ifFalseDepth = Math.max(0, ifFalseDepth - 1);
        }
        continue;
      }

      this.lintSmartQuotes(codeOnly, rawLine, lineNum, filename, diagnostics);
      this.lintCitationKeys(
        codeOnly,
        rawLine,
        lineNum,
        filename,
        knownBibKeys,
        diagnostics,
      );
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

    this.lintUnclosedBraces(braceStack, filename, diagnostics);
    this.lintUnclosedEnvironments(envStack, filename, diagnostics);
    this.lintUnclosedMath(mathState, filename, diagnostics);

    return diagnostics;
  }

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

      this.trackEnvironmentsForAutoFix(line, unclosedEnvs);
      line = this.fixSmartQuotes(line, lineNum, appliedFixes);
      line = this.fixNakedPercentages(line, lineNum, appliedFixes);
      line = this.fixNakedUnderscores(line, lineNum, appliedFixes);

      fixedLines.push(line);
    }

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
            'Unicode smart quotes detected (“” or ‘’). pdfTeX may fail to render these characters.',
          context: rawLine.trim(),
          code: 'SMART_QUOTES',
          explanation:
            this.explainer?.getByCode('UNDEFINED_CONTROL_SEQUENCE') ||
            undefined,
          quickFix: {
            description:
              "Convert Unicode quotes to standard LaTeX quotes (`` or '')",
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
      /\\(?:cite[a-zA-Z]*|newcite|shortcite|parencite|footcite|textcite|smartcite|autocite|nocite)\*?(?:\[[^\]]*\])*\{([^}]+)\}/g,
    );
    for (const m of citeMatches) {
      if (m[1]) {
        const keys = m[1].split(',').map((k) => k.trim());
        for (const key of keys) {
          if (key && key !== '*' && !knownBibKeys.has(key)) {
            diagnostics.push(
              new DiagnosticItem({
                file: filename,
                line: lineNum,
                severity: DiagnosticSeverityVo.warning(),
                message: `Citation key "${key}" not found in project bibliography (.bib) files.`,
                context: rawLine.trim(),
                code: 'MISSING_CITATION_KEY',
                explanation:
                  this.explainer?.getByCode('UNDEFINED_CITATION') || undefined,
                quickFix: {
                  description: `Add bibliography entry @article{${key}, ...} to references.bib`,
                  replacementText: key,
                },
              }),
            );
          }
        }
      }
    }
  }

  private computeTechnicalMask(codeOnly: string): Uint8Array {
    const mask = new Uint8Array(codeOnly.length);

    const verbRegex = /\\verb\*?([^a-zA-Z\s])([\s\S]*?)\1/g;
    let vMatch: RegExpExecArray | null;
    while ((vMatch = verbRegex.exec(codeOnly)) !== null) {
      for (
        let k = vMatch.index;
        k < vMatch.index + vMatch[0].length && k < mask.length;
        k++
      ) {
        mask[k] = 2;
      }
    }

    TECHNICAL_COMMAND_REGEX.lastIndex = 0;
    let cMatch: RegExpExecArray | null;
    while ((cMatch = TECHNICAL_COMMAND_REGEX.exec(codeOnly)) !== null) {
      const startBrace = codeOnly.indexOf('{', cMatch.index);
      const start = startBrace !== -1 ? startBrace + 1 : cMatch.index;
      const end = cMatch.index + cMatch[0].length - 1;
      for (let k = start; k < end && k < mask.length; k++) {
        if (mask[k] === 0) mask[k] = 1;
      }
    }

    return mask;
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
    const techMask = this.computeTechnicalMask(codeOnly);
    let i = 0;
    while (i < codeOnly.length) {
      if (techMask[i] === 2) {
        i++;
        continue;
      }

      const char = codeOnly[i];
      const nextChar = i + 1 < codeOnly.length ? codeOnly[i + 1] : '';

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
        if (nextChar === '(') {
          mathState.inInlineMathParen = true;
          mathState.inlineMathStartLine = lineNum;
          i += 2;
          continue;
        }
        if (nextChar === ')') {
          mathState.inInlineMathParen = false;
          i += 2;
          continue;
        }

        const beginMatch = codeOnly.slice(i).match(/^\\begin\{([^}]+)\}/);
        if (beginMatch && beginMatch[1]) {
          const envName = beginMatch[1].trim();
          envStack.push({ name: envName, line: lineNum });
          i += beginMatch[0].length;
          continue;
        }

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

        i += 2;
        continue;
      }

      if (char === '$' && nextChar === '$') {
        mathState.inDisplayMathDollar = !mathState.inDisplayMathDollar;
        if (mathState.inDisplayMathDollar)
          mathState.displayMathStartLine = lineNum;
        i += 2;
        continue;
      }

      if (char === '$') {
        mathState.inInlineMath = !mathState.inInlineMath;
        if (mathState.inInlineMath) mathState.inlineMathStartLine = lineNum;
        i++;
        continue;
      }

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
                'Stray closing brace "}" without matching opening brace.',
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

      if (techMask[i] === 1) {
        i++;
        continue;
      }

      const isCurrentInMath =
        mathState.inInlineMath ||
        mathState.inInlineMathParen ||
        mathState.inDisplayMathBracket ||
        mathState.inDisplayMathDollar ||
        envStack.some((e) => MATH_ENVIRONMENTS.has(e.name));

      if (!isCurrentInMath) {
        if (char === '_' || char === '^') {
          diagnostics.push(
            new DiagnosticItem({
              file: filename,
              line: lineNum,
              column: i + 1,
              severity: DiagnosticSeverityVo.error(),
              message: `Math operator "${char}" found outside math mode. Wrap in $...$ or escape as "\\${char}".`,
              context: rawLine.trim(),
              code: 'MISSING_MATH_DELIMITER',
              explanation:
                this.explainer?.getByCode('MISSING_MATH_DELIMITER') ||
                undefined,
              quickFix: {
                description: `Escape "${char}" as "\\${char}"`,
                replacementText: `\\${char}`,
              },
            }),
          );
        }

        if (char === '&') {
          const isCurrentInTable = envStack.some((e) =>
            TABLE_ENVIRONMENTS.has(e.name),
          );
          if (!isCurrentInTable) {
            diagnostics.push(
              new DiagnosticItem({
                file: filename,
                line: lineNum,
                column: i + 1,
                severity: DiagnosticSeverityVo.error(),
                message:
                  'Column delimiter "&" used outside table environment. Use "\\&" for plain-text ampersands.',
                context: rawLine.trim(),
                code: 'EXTRA_ALIGNMENT_TAB',
                explanation:
                  this.explainer?.getByCode('EXTRA_ALIGNMENT_TAB') || undefined,
                quickFix: {
                  description: 'Escape & as \\&',
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
            message: `Environment \\begin{${unclosed.name}} on line ${unclosed.line} is not closed before end of file.`,
            code: 'UNCLOSED_ENVIRONMENT',
            explanation:
              this.explainer?.getByCode('ENVIRONMENT_MISMATCH') || undefined,
            quickFix: {
              description: `Add \\end{${unclosed.name}} to close environment`,
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
          message: `Environment \\begin{${top.name}} (on line ${top.line}) was closed with mismatched \\end{${endEnvName}}.`,
          context: rawLine.trim(),
          code: 'ENVIRONMENT_MISMATCH',
          explanation:
            this.explainer?.getByCode('ENVIRONMENT_MISMATCH') || undefined,
          quickFix: {
            description: `Change to \\end{${top.name}}`,
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
          message: `Stray \\end{${endEnvName}} without matching \\begin.`,
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
          message: `Opening brace "{" on line ${unclosed.line} was never closed with "}".`,
          code: 'UNBALANCED_BRACES',
          explanation:
            this.explainer?.getByCode('UNBALANCED_BRACES') || undefined,
          quickFix: {
            description: 'Add closing brace "}"',
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
          message: `Environment \\begin{${unclosed.name}} on line ${unclosed.line} is not closed before end of file.`,
          code: 'UNCLOSED_ENVIRONMENT',
          explanation:
            this.explainer?.getByCode('ENVIRONMENT_MISMATCH') || undefined,
          quickFix: {
            description: `Add \\end{${unclosed.name}} at end of file`,
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
          message: `Display math \\[ opened on line ${mathState.displayMathStartLine} was never closed with \\].`,
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
          message: `Display math $$ opened on line ${mathState.displayMathStartLine} was never closed with $$.`,
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
          message: `Inline math $ opened on line ${mathState.inlineMathStartLine} was never closed with $.`,
          code: 'MISSING_MATH_DELIMITER',
          explanation:
            this.explainer?.getByCode('MISSING_MATH_DELIMITER') || undefined,
        }),
      );
    }

    if (mathState.inInlineMathParen) {
      diagnostics.push(
        new DiagnosticItem({
          file: filename,
          line: mathState.inlineMathStartLine,
          severity: DiagnosticSeverityVo.error(),
          message: `Inline math \\( opened on line ${mathState.inlineMathStartLine} was never closed with \\).`,
          code: 'MISSING_MATH_DELIMITER',
          explanation:
            this.explainer?.getByCode('MISSING_MATH_DELIMITER') || undefined,
        }),
      );
    }
  }

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
    const codeOnly = this.stripComment(line);
    const beginMatches = codeOnly.matchAll(/\\begin\{([^}]+)\}/g);
    for (const m of beginMatches) {
      if (m[1]) unclosedEnvs.push(m[1].trim());
    }
    const endMatches = codeOnly.matchAll(/\\end\{([^}]+)\}/g);
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
    const codeOnly = this.stripComment(line);
    const commentTail = line.slice(codeOnly.length);
    if (/[“”‘’]/.test(codeOnly)) {
      appliedFixes.push({
        line: lineNum,
        rule: 'SMART_QUOTES',
        description: 'Convert Unicode smart quotes to standard LaTeX quotes',
      });
      return (
        codeOnly
          .replace(/“/g, '``')
          .replace(/”/g, "''")
          .replace(/‘/g, '`')
          .replace(/’/g, "'") + commentTail
      );
    }
    return line;
  }

  private fixNakedPercentages(
    line: string,
    lineNum: number,
    appliedFixes: AppliedFix[],
  ): string {
    if (/^\s*%/.test(line)) return line;
    const codeOnly = this.stripComment(line);
    const commentTail = line.slice(codeOnly.length);
    const percentFix = codeOnly.replace(
      /(?<!\\)(\d+(?:\.\d+)?)\s*%(?=\s*[a-zA-Z,;.)\]}])/g,
      '$1\\%',
    );
    if (percentFix !== codeOnly) {
      appliedFixes.push({
        line: lineNum,
        rule: 'UNESCAPED_PERCENT',
        description: 'Escape plain-text percent symbol as \\%',
      });
      return percentFix + commentTail;
    }
    return line;
  }

  private fixNakedUnderscores(
    line: string,
    lineNum: number,
    appliedFixes: AppliedFix[],
  ): string {
    const codeOnly = this.stripComment(line);
    const commentTail = line.slice(codeOnly.length);
    const techMask = this.computeTechnicalMask(codeOnly);

    let fixedChars = '';
    let isMathChar = false;
    let underscoreFixed = false;

    for (let cIdx = 0; cIdx < codeOnly.length; cIdx++) {
      const c = codeOnly[cIdx];
      const prevC = cIdx > 0 ? codeOnly[cIdx - 1] : '';
      if (c === '$' && prevC !== '\\' && techMask[cIdx] !== 2) {
        isMathChar = !isMathChar;
      }
      if (c === '_' && !isMathChar && prevC !== '\\' && techMask[cIdx] === 0) {
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
        description: 'Escape plain-text underscore "_" as "\\_"',
      });
      return fixedChars + commentTail;
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
        description: `Automatically append missing \\end{${env}} at end of file`,
      });
    }
  }

  private stripComment(line: string): string {
    let result = '';
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) {
        if (
          i > 0 &&
          /\d/.test(line[i - 1]) &&
          /^\s*[a-zA-Z,;.)\]}]/.test(line.slice(i + 1))
        ) {
          result += line[i];
          continue;
        }
        break;
      }
      result += line[i];
    }
    return result;
  }
}
