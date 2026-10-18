/**
 * modules/manuscripts/diagnostics/domain/diagnostics.ports.ts
 * Domain port interfaces and DI tokens for Diagnostics.
 */

import { DiagnosticItem } from './diagnostic-item.entity';
import { ErrorExplanationVo } from './error-explanation.vo';
import { AppliedFix, AutoFixResult } from './fast-syntax.linter';

export const ERROR_EXPLAINER_PORT = Symbol('ERROR_EXPLAINER_PORT');

export interface IErrorExplainerPort {
  explain(message: string, context?: string): ErrorExplanationVo | null;
  getByCode(code: string): ErrorExplanationVo | null;
  getAllRules(): ErrorExplanationVo[];
}

export const LATEX_LOG_PARSER_PORT = Symbol('LATEX_LOG_PARSER_PORT');

export interface ILatexLogParserPort {
  parse(logText: string, defaultFile?: string): DiagnosticItem[];
}

export const SYNTAX_LINTER_PORT = Symbol('SYNTAX_LINTER_PORT');

export type { AppliedFix, AutoFixResult };

export interface ISyntaxLinterPort {
  lint(
    source: string,
    filename?: string,
    knownBibKeys?: Set<string>,
  ): DiagnosticItem[];
  autoFix?(source: string): AutoFixResult;
}
