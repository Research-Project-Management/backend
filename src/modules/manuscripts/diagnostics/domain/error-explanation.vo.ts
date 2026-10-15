/**
 * diagnostics/core/domain/value-objects/error-explanation.vo.ts
 * Value Object encapsulating a human-friendly explanation, causes, and remedy suggestions.
 */

export interface ErrorExplanationProps {
  code: string;
  title: string;
  explanation: string;
  commonCauses: string[];
  suggestedFix?: string;
  exampleSnippet?: string;
  documentationUrl?: string;
}

export class ErrorExplanationVo {
  public readonly code: string;
  public readonly title: string;
  public readonly explanation: string;
  public readonly commonCauses: readonly string[];
  public readonly suggestedFix?: string;
  public readonly exampleSnippet?: string;
  public readonly documentationUrl?: string;

  constructor(props: ErrorExplanationProps) {
    this.code = props.code;
    this.title = props.title;
    this.explanation = props.explanation;
    this.commonCauses = Object.freeze([...props.commonCauses]);
    this.suggestedFix = props.suggestedFix;
    this.exampleSnippet = props.exampleSnippet;
    this.documentationUrl = props.documentationUrl;
  }

  public toJSON() {
    return {
      code: this.code,
      title: this.title,
      explanation: this.explanation,
      commonCauses: [...this.commonCauses],
      suggestedFix: this.suggestedFix,
      exampleSnippet: this.exampleSnippet,
      documentationUrl: this.documentationUrl,
    };
  }
}
