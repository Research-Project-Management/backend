/**
 * diagnostics/core/use-cases/get-error-explanation.use-case.ts
 * Inbound Use Case: Retrieves detailed error explanation and suggested remedy by code.
 */

import { IErrorExplainerPort } from '../ports/error-explainer.port';
import { ErrorExplanationVo } from '../domain/value-objects/error-explanation.vo';
import { ExplanationNotFoundException } from '../domain/exceptions/explanation-not-found.exception';

export class GetErrorExplanationUseCase {
  constructor(private readonly explainer: IErrorExplainerPort) {}

  public execute(code: string): ErrorExplanationVo {
    if (!code || typeof code !== 'string') {
      throw new ExplanationNotFoundException(String(code));
    }

    const explanation = this.explainer.getByCode(code);
    if (!explanation) {
      throw new ExplanationNotFoundException(code);
    }

    return explanation;
  }

  public listRules(): ErrorExplanationVo[] {
    return this.explainer.getAllRules();
  }
}
