import {
  FieldMappingChange,
  DroppedField,
} from '@/modules/library/core/types/bibliographic.types';
import {
  FIELD_ALIASES,
  REVERSE_FIELD_ALIASES,
} from '@/modules/library/catalog/types/items.constants';

export interface TypeConversionRuleContext {
  sourceType: string;
  targetType: string;
  sourceValues: Record<string, unknown>;
  projectedItem: Record<string, unknown>;
  mappedFields: FieldMappingChange[];
  droppedFields: DroppedField[];
  unmappedRetained: Record<string, unknown>;
  newExtraFields: Record<string, unknown>;
  retainUnmappedInExtra: boolean;
}

export interface ITypeConversionRule {
  readonly id: string;
  readonly description: string;
  matches(sourceType: string, targetType: string): boolean;
  apply(ctx: TypeConversionRuleContext): void;
}

function remapFieldInContext(
  ctx: TypeConversionRuleContext,
  fromField: string,
  toField: string,
  ruleKind: FieldMappingChange['rule'] = 'special-rule',
): boolean {
  const val = ctx.sourceValues[fromField];
  if (val === undefined || val === null || val === '') {
    return false;
  }
  ctx.projectedItem[toField] = val;
  const dbCol = FIELD_ALIASES[toField];
  if (dbCol) {
    ctx.projectedItem[dbCol] = val;
  }
  if (fromField !== toField) {
    delete ctx.projectedItem[fromField];
    delete ctx.newExtraFields[fromField];
    const fromAlias =
      FIELD_ALIASES[fromField] || REVERSE_FIELD_ALIASES[fromField];
    if (fromAlias && fromAlias !== toField) {
      delete ctx.projectedItem[fromAlias];
      delete ctx.newExtraFields[fromAlias];
    }
  }
  ctx.mappedFields.push({
    fromField,
    toField,
    value: val,
    rule: ruleKind,
  });
  delete ctx.sourceValues[fromField];
  return true;
}

/**
 * Rule 1: `book` -> `bookSection`
 * Container book `title` shifts into `bookTitle`, clearing the section's `title` and `shortTitle`.
 */
export class BookToBookSectionConversionRule implements ITypeConversionRule {
  readonly id = 'BOOK_TO_BOOK_SECTION';
  readonly description =
    'Moves book title into bookTitle when converting book -> bookSection';

  matches(sourceType: string, targetType: string): boolean {
    return sourceType === 'book' && targetType === 'bookSection';
  }

  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.title) {
      ctx.projectedItem.bookTitle = ctx.sourceValues.title;
      ctx.projectedItem.title = '';
      ctx.mappedFields.push({
        fromField: 'title',
        toField: 'bookTitle',
        value: ctx.sourceValues.title,
        rule: 'special-rule',
      });
      delete ctx.sourceValues.title;
    }
    delete ctx.projectedItem.shortTitle;
    delete ctx.sourceValues.shortTitle;
  }
}

/**
 * Rule 2: `bookSection` -> `book`
 * Container `bookTitle` becomes the top-level `title`; any existing chapter `title`
 * is recorded in `droppedFields` / `unmappedRetained` as `sectionTitle`.
 */
export class BookSectionToBookConversionRule implements ITypeConversionRule {
  readonly id = 'BOOK_SECTION_TO_BOOK';
  readonly description =
    'Promotes bookTitle to title and retains chapter title as sectionTitle when converting bookSection -> book';

  matches(sourceType: string, targetType: string): boolean {
    return sourceType === 'bookSection' && targetType === 'book';
  }

  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.bookTitle) {
      const chapterTitle = ctx.sourceValues.title;
      ctx.projectedItem.title = ctx.sourceValues.bookTitle;
      ctx.mappedFields.push({
        fromField: 'bookTitle',
        toField: 'title',
        value: ctx.sourceValues.bookTitle,
        rule: 'special-rule',
      });
      delete ctx.sourceValues.bookTitle;
      delete ctx.sourceValues.title;

      if (chapterTitle) {
        ctx.droppedFields.push({
          field: 'sectionTitle',
          label: 'Section Title',
          value: chapterTitle,
        });
        ctx.unmappedRetained.sectionTitle = chapterTitle;
        if (ctx.retainUnmappedInExtra) {
          ctx.newExtraFields[`__unmapped_${ctx.sourceType}_sectionTitle`] =
            chapterTitle;
        }
      }
    }
    delete ctx.projectedItem.shortTitle;
    delete ctx.sourceValues.shortTitle;
  }
}

/**
 * Rule 3: `*` -> `conferencePaper`
 * Transfers container title (`publicationTitle` / `journal` / `bookTitle`) into `proceedingsTitle`
 * if `proceedingsTitle` is not already populated.
 */
export class ToConferencePaperConversionRule implements ITypeConversionRule {
  readonly id = 'TO_CONFERENCE_PAPER_CONTAINER';
  readonly description =
    'Maps container venue (publicationTitle / bookTitle) to proceedingsTitle when converting to conferencePaper';

  matches(sourceType: string, targetType: string): boolean {
    return sourceType !== 'conferencePaper' && targetType === 'conferencePaper';
  }

  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.proceedingsTitle !== undefined) return;
    for (const candidate of ['publicationTitle', 'journal', 'bookTitle']) {
      if (
        remapFieldInContext(ctx, candidate, 'proceedingsTitle', 'base-semantic')
      ) {
        break;
      }
    }
  }
}

/**
 * Rule 4: `*` -> `journalArticle`
 * Transfers container title (`proceedingsTitle` / `bookTitle` / `repository`) into `publicationTitle`
 * if `publicationTitle` is not already populated.
 */
export class ToJournalArticleConversionRule implements ITypeConversionRule {
  readonly id = 'TO_JOURNAL_ARTICLE_CONTAINER';
  readonly description =
    'Maps proceedingsTitle, bookTitle, or repository to publicationTitle when converting to journalArticle';

  matches(sourceType: string, targetType: string): boolean {
    return sourceType !== 'journalArticle' && targetType === 'journalArticle';
  }

  apply(ctx: TypeConversionRuleContext): void {
    if (
      ctx.sourceValues.publicationTitle !== undefined ||
      ctx.sourceValues.journal !== undefined
    ) {
      return;
    }
    const candidates =
      ctx.sourceType === 'preprint'
        ? ['proceedingsTitle', 'bookTitle']
        : ['proceedingsTitle', 'bookTitle', 'repository'];
    for (const candidate of candidates) {
      if (
        remapFieldInContext(ctx, candidate, 'publicationTitle', 'base-semantic')
      ) {
        break;
      }
    }
  }
}

/**
 * Rule 5: `*` -> `preprint`
 * Transfers publisher/venue (`publisher`, `institution`, `publicationTitle`) into `repository`
 * when `repository` is not already populated.
 */
export class ToPreprintConversionRule implements ITypeConversionRule {
  readonly id = 'TO_PREPRINT_REPOSITORY';
  readonly description =
    'Maps institution, publisher, or publicationTitle to repository when converting to preprint';

  matches(sourceType: string, targetType: string): boolean {
    return sourceType !== 'preprint' && targetType === 'preprint';
  }

  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.repository !== undefined) return;
    for (const candidate of ['institution', 'publisher', 'publicationTitle']) {
      if (remapFieldInContext(ctx, candidate, 'repository', 'base-semantic')) {
        break;
      }
    }
  }
}

/**
 * Rule 6: `*` -> `thesis`
 * Transfers `publisher` or `institution` into `university` when `university` is not already populated.
 */
export class ToThesisConversionRule implements ITypeConversionRule {
  readonly id = 'TO_THESIS_UNIVERSITY';
  readonly description =
    'Maps publisher or institution to university when converting to thesis';

  matches(sourceType: string, targetType: string): boolean {
    return sourceType !== 'thesis' && targetType === 'thesis';
  }

  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.university !== undefined) return;
    for (const candidate of ['institution', 'publisher']) {
      if (remapFieldInContext(ctx, candidate, 'university', 'base-semantic')) {
        break;
      }
    }
  }
}

/**
 * Rule 7: `*` -> `report`
 * Transfers `publisher` or `university` into `institution` when `institution` is not already populated.
 */
export class ToReportConversionRule implements ITypeConversionRule {
  readonly id = 'TO_REPORT_INSTITUTION';
  readonly description =
    'Maps publisher or university to institution when converting to report';

  matches(sourceType: string, targetType: string): boolean {
    return sourceType !== 'report' && targetType === 'report';
  }

  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.institution !== undefined) return;
    for (const candidate of ['publisher', 'university']) {
      if (remapFieldInContext(ctx, candidate, 'institution', 'base-semantic')) {
        break;
      }
    }
  }
}

/**
 * Rule 8: `*` -> `patent`
 * Transfers `place` -> `country` and `publisher` / `authority` -> `issuingAuthority`.
 */
export class ToPatentConversionRule implements ITypeConversionRule {
  readonly id = 'TO_PATENT_AUTHORITY';
  readonly description =
    'Maps place to country and authority/publisher to issuingAuthority when converting to patent';

  matches(sourceType: string, targetType: string): boolean {
    return sourceType !== 'patent' && targetType === 'patent';
  }

  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.country === undefined) {
      remapFieldInContext(ctx, 'place', 'country', 'base-semantic');
    }
    if (ctx.sourceValues.issuingAuthority === undefined) {
      for (const candidate of ['authority', 'publisher', 'institution']) {
        if (
          remapFieldInContext(
            ctx,
            candidate,
            'issuingAuthority',
            'base-semantic',
          )
        ) {
          break;
        }
      }
    }
  }
}

/**
 * Rule 9: `*` -> `case`
 * Transfers `publicationTitle` -> `reporter` and `publisher` / `authority` -> `court`.
 */
export class ToCaseConversionRule implements ITypeConversionRule {
  readonly id = 'TO_CASE_REPORTER_COURT';
  readonly description =
    'Maps publicationTitle to reporter and authority/publisher to court when converting to legal case';

  matches(sourceType: string, targetType: string): boolean {
    return sourceType !== 'case' && targetType === 'case';
  }

  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.reporter === undefined) {
      remapFieldInContext(ctx, 'publicationTitle', 'reporter', 'base-semantic');
    }
    if (ctx.sourceValues.court === undefined) {
      for (const candidate of ['authority', 'publisher']) {
        if (remapFieldInContext(ctx, candidate, 'court', 'base-semantic')) {
          break;
        }
      }
    }
  }
}

/**
 * Rule 10: `*` -> `statute`
 * Transfers `publicationTitle` -> `code` and `volume` -> `codeNumber`.
 */
export class ToStatuteConversionRule implements ITypeConversionRule {
  readonly id = 'TO_STATUTE_CODE';
  readonly description =
    'Maps publicationTitle to code and volume to codeNumber when converting to statute';

  matches(sourceType: string, targetType: string): boolean {
    return sourceType !== 'statute' && targetType === 'statute';
  }

  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.code === undefined) {
      remapFieldInContext(ctx, 'publicationTitle', 'code', 'base-semantic');
    }
    if (ctx.sourceValues.codeNumber === undefined) {
      remapFieldInContext(ctx, 'volume', 'codeNumber', 'base-semantic');
    }
  }
}

export const TYPE_CONVERSION_RULES: readonly ITypeConversionRule[] = [
  new BookToBookSectionConversionRule(),
  new BookSectionToBookConversionRule(),
  new ToConferencePaperConversionRule(),
  new ToJournalArticleConversionRule(),
  new ToPreprintConversionRule(),
  new ToThesisConversionRule(),
  new ToReportConversionRule(),
  new ToPatentConversionRule(),
  new ToCaseConversionRule(),
  new ToStatuteConversionRule(),
];

export function applyStructuralTypeConversionRules(
  sourceType: string,
  targetType: string,
  ctx: Omit<TypeConversionRuleContext, 'sourceType' | 'targetType'>,
  rules: readonly ITypeConversionRule[] = TYPE_CONVERSION_RULES,
): void {
  const fullContext: TypeConversionRuleContext = {
    sourceType,
    targetType,
    ...ctx,
  };
  for (const rule of rules) {
    if (rule.matches(sourceType, targetType)) {
      rule.apply(fullContext);
    }
  }
}
