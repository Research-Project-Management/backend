/**
 * citations/core/domain/value-objects/academic-identifier.vo.ts
 * Value Object identifying and standardizing DOI, arXiv, and ISBN identifiers.
 */

export type IdentifierType = 'doi' | 'arxiv' | 'isbn' | 'unknown';

export class AcademicIdentifierVo {
  private static readonly DOI_REGEX =
    /(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)/i;

  private static readonly ARXIV_REGEX =
    /(?:https?:\/\/arxiv\.org\/(?:abs|pdf)\/|arxiv:\s*)?(\d{4}\.\d{4,5}(?:v\d+)?|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})/i;

  private static readonly ISBN_REGEX =
    /(?:ISBN(?:-1[03])?:?\s*)?(?=[-0-9 ]{13}$|[-0-9X ]{10}$|[0-9X]{10}$|[0-9]{13}$)(?:97[89][- ]?)?[0-9]{1,5}[- ]?[0-9]+[- ]?[0-9]+[- ]?[0-9X]/i;

  private constructor(
    public readonly type: IdentifierType,
    public readonly raw: string,
    public readonly clean: string
  ) {}

  public static parse(input: string): AcademicIdentifierVo {
    if (!input || typeof input !== 'string') {
      return new AcademicIdentifierVo('unknown', '', '');
    }

    const trimmed = input.trim();

    // 1. Check DOI
    const doiMatch = trimmed.match(AcademicIdentifierVo.DOI_REGEX);
    if (doiMatch && doiMatch[1]) {
      return new AcademicIdentifierVo('doi', trimmed, doiMatch[1]);
    }

    // 2. Check arXiv
    const arxivMatch = trimmed.match(AcademicIdentifierVo.ARXIV_REGEX);
    if (arxivMatch && arxivMatch[1]) {
      return new AcademicIdentifierVo('arxiv', trimmed, arxivMatch[1]);
    }

    // 3. Check ISBN
    const isbnMatch = trimmed.match(AcademicIdentifierVo.ISBN_REGEX);
    if (isbnMatch && isbnMatch[0]) {
      const cleanIsbn = isbnMatch[0].replace(/[^0-9X]/gi, '');
      return new AcademicIdentifierVo('isbn', trimmed, cleanIsbn);
    }

    return new AcademicIdentifierVo('unknown', trimmed, trimmed);
  }

  public isDoi(): boolean {
    return this.type === 'doi';
  }

  public isArxiv(): boolean {
    return this.type === 'arxiv';
  }

  public isIsbn(): boolean {
    return this.type === 'isbn';
  }
}
