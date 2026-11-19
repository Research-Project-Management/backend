/**
 * modules/pages/diagnostics/domain/syntax.linter.ts
 * Pure domain static syntax linter & pre-compile auto-fixer for LaTeX documents.
 * Zero I/O, zero NestJS imports.
 */

import { DiagnosticItem } from './diagnostic-item.entity';
import { DiagnosticReport } from './diagnostic-report.entity';
import {
  ErrorKnowledgeBase,
  type ErrorExplainerLike,
} from './error-knowledge-base';
import {
  type MathScanState,
  isLineInVerbatim,
  lintCitationKeys,
  lintLabelsAndRefs,
  lintSmartQuotes,
  lintUnclosedBraces,
  lintUnclosedEnvironments,
  lintUnclosedMath,
  scanLineCharacters,
  stripLatexComment,
} from './latex-syntax.scanner';
import {
  createDefaultLineAutoFixRules,
  runLatexAutoFix,
  type AppliedFix,
  type AutoFixResult,
  type ILatexLineAutoFixRule,
} from './latex-autofix.engine';

export type { AppliedFix, AutoFixResult, ILatexLineAutoFixRule };

export class SyntaxLinter {
  private readonly explainer?: ErrorExplainerLike;
  private readonly lineAutoFixRules: ILatexLineAutoFixRule[] = [];

  constructor(
    explainer?: ErrorExplainerLike,
    customAutoFixRules?: ILatexLineAutoFixRule[],
  ) {
    this.explainer = explainer ?? new ErrorKnowledgeBase();
    this.lineAutoFixRules =
      customAutoFixRules ?? createDefaultLineAutoFixRules();
  }

  public registerAutoFixRule(rule: ILatexLineAutoFixRule): void {
    const existingIdx = this.lineAutoFixRules.findIndex(
      (r) => r.id === rule.id,
    );
    if (existingIdx >= 0) {
      this.lineAutoFixRules[existingIdx] = rule;
    } else {
      this.lineAutoFixRules.push(rule);
    }
  }

  public getAutoFixRuleIds(): string[] {
    return this.lineAutoFixRules.map((r) => r.id);
  }

  public lintToReport(
    source: string,
    filename = 'main.tex',
    knownBibKeys?: Set<string>,
    knownLabels?: Set<string>,
  ): DiagnosticReport {
    const items = this.lint(
      source ?? '',
      filename || 'main.tex',
      knownBibKeys,
      knownLabels,
    );
    return new DiagnosticReport({
      items,
      rawLog: undefined,
    });
  }

  public lint(
    source: string,
    filename = 'main.tex',
    knownBibKeys?: Set<string>,
    knownLabels?: Set<string>,
  ): DiagnosticItem[] {
    const diagnostics: DiagnosticItem[] = [];
    if (/^%novalidate\b/m.test(source)) {
      return diagnostics;
    }

    const lines = source.split('\n');
    const seenLabelsInDoc = new Set<string>();

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
    let inNovalidateBlock = false;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      const lineNum = lineIdx + 1;
      const rawLine = lines[lineIdx] || '';

      const trimmedComment = rawLine.trim();
      if (trimmedComment === '%begin novalidate') {
        inNovalidateBlock = true;
        continue;
      }
      if (trimmedComment === '%end novalidate') {
        inNovalidateBlock = false;
        continue;
      }
      if (inNovalidateBlock) {
        continue;
      }

      if (isLineInVerbatim(rawLine, envStack)) {
        continue;
      }

      const codeOnly = stripLatexComment(rawLine);

      if (/\\iffalse\b/.test(codeOnly)) {
        ifFalseDepth++;
      }
      if (ifFalseDepth > 0) {
        if (/\\fi\b/.test(codeOnly)) {
          ifFalseDepth = Math.max(0, ifFalseDepth - 1);
        }
        continue;
      }

      lintSmartQuotes(
        codeOnly,
        rawLine,
        lineNum,
        filename,
        diagnostics,
        this.explainer,
      );
      lintCitationKeys(
        codeOnly,
        rawLine,
        lineNum,
        filename,
        knownBibKeys,
        diagnostics,
        this.explainer,
      );
      lintLabelsAndRefs(
        codeOnly,
        rawLine,
        lineNum,
        filename,
        seenLabelsInDoc,
        knownLabels,
        diagnostics,
      );
      scanLineCharacters(
        codeOnly,
        rawLine,
        lineNum,
        filename,
        envStack,
        braceStack,
        mathState,
        diagnostics,
        this.explainer,
      );
    }

    lintUnclosedBraces(braceStack, filename, diagnostics, this.explainer);
    lintUnclosedEnvironments(envStack, filename, diagnostics, this.explainer);
    lintUnclosedMath(mathState, filename, diagnostics, this.explainer);

    return diagnostics;
  }

  public autoFix(source: string): AutoFixResult {
    return runLatexAutoFix(source, this.lineAutoFixRules);
  }
}

/** @deprecated Use SyntaxLinter */
export { SyntaxLinter as FastSyntaxLinter };
