/**
 * diagnostics/core/ports/error-explainer.port.ts
 * Outbound SPI Port for matching LaTeX errors with human-friendly explanations and fixes.
 */

import { ErrorExplanationVo } from '../domain/value-objects/error-explanation.vo';

export const ERROR_EXPLAINER_PORT = Symbol('ERROR_EXPLAINER_PORT');

export interface IErrorExplainerPort {
  /**
   * Attempt to find a matching explanation based on the raw error message and optional context.
   */
  explain(message: string, context?: string): ErrorExplanationVo | null;

  /**
   * Retrieve an explanation directly by its canonical error code.
   */
  getByCode(code: string): ErrorExplanationVo | null;

  /**
   * List all known explanation rules in the knowledge base.
   */
  getAllRules(): ErrorExplanationVo[];
}
