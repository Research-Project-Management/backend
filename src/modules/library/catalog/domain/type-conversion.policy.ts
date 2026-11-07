import {
  ItemsMapper, ItemProvenancePolicy, getEffectiveBaseFieldMap, getEffectiveReverseBaseFieldMap, SCHEMA_V42_DATA,
} from '@/modules/library/core';
import {
  ItemDetail, TypeConversionPreview, FieldMappingChange, DroppedField, CreatorRoleChange,
} from '@/modules/library/core/types/bibliographic.types';
import { ITEM_COLUMN_METADATA_FIELDS, FIELD_ALIASES, REVERSE_FIELD_ALIASES } from '@/modules/library/catalog/types/catalog.types';
import { ItemFieldDefinition, CreatorTypeDefinition } from '@/modules/library/core/types/schema.types';

export interface TypeConversionRuleContext {
  sourceType: string; targetType: string; sourceValues: Record<string, unknown>;
  projectedItem: Record<string, unknown>; mappedFields: FieldMappingChange[];
  droppedFields: DroppedField[]; unmappedRetained: Record<string, unknown>;
  newExtraFields: Record<string, unknown>; retainUnmappedInExtra: boolean;
}

export interface ITypeConversionRule {
  readonly id: string;
  readonly description: string;
  matches(sourceType: string, targetType: string): boolean;
  apply(ctx: TypeConversionRuleContext): void;
}

function remapFieldInContext(
  ctx: TypeConversionRuleContext, fromField: string, toField: string,
  ruleKind: FieldMappingChange['rule'] = 'special-rule',
): boolean {
  const val = ctx.sourceValues[fromField];
  if (val === undefined || val === null || val === '') return false;
  ctx.projectedItem[toField] = val;
  const dbCol = FIELD_ALIASES[toField];
  if (dbCol) ctx.projectedItem[dbCol] = val;
  if (fromField !== toField) {
    delete ctx.projectedItem[fromField];
    delete ctx.newExtraFields[fromField];
    const fromAlias = FIELD_ALIASES[fromField] || REVERSE_FIELD_ALIASES[fromField];
    if (fromAlias && fromAlias !== toField) {
      delete ctx.projectedItem[fromAlias];
      delete ctx.newExtraFields[fromAlias];
    }
  }
  ctx.mappedFields.push({ fromField, toField, value: val, rule: ruleKind });
  delete ctx.sourceValues[fromField];
  return true;
}

class BookToBookSectionConversionRule implements ITypeConversionRule {
  readonly id = 'BOOK_TO_BOOK_SECTION';
  readonly description = 'Moves book title into bookTitle when converting book -> bookSection';
  matches(s: string, t: string): boolean { return s === 'book' && t === 'bookSection'; }
  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.title) {
      ctx.projectedItem.bookTitle = ctx.sourceValues.title;
      ctx.projectedItem.title = '';
      ctx.mappedFields.push({ fromField: 'title', toField: 'bookTitle', value: ctx.sourceValues.title, rule: 'special-rule' });
      delete ctx.sourceValues.title;
    }
    delete ctx.projectedItem.shortTitle;
    delete ctx.sourceValues.shortTitle;
  }
}

class BookSectionToBookConversionRule implements ITypeConversionRule {
  readonly id = 'BOOK_SECTION_TO_BOOK';
  readonly description = 'Promotes bookTitle to title and retains chapter title as sectionTitle when converting bookSection -> book';
  matches(s: string, t: string): boolean { return s === 'bookSection' && t === 'book'; }
  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.bookTitle) {
      const chapterTitle = ctx.sourceValues.title;
      ctx.projectedItem.title = ctx.sourceValues.bookTitle;
      ctx.mappedFields.push({ fromField: 'bookTitle', toField: 'title', value: ctx.sourceValues.bookTitle, rule: 'special-rule' });
      delete ctx.sourceValues.bookTitle;
      delete ctx.sourceValues.title;
      if (chapterTitle) {
        ctx.droppedFields.push({ field: 'sectionTitle', label: 'Section Title', value: chapterTitle });
        ctx.unmappedRetained.sectionTitle = chapterTitle;
        if (ctx.retainUnmappedInExtra) ctx.newExtraFields[`__unmapped_${ctx.sourceType}_sectionTitle`] = chapterTitle;
      }
    }
    delete ctx.projectedItem.shortTitle;
    delete ctx.sourceValues.shortTitle;
  }
}

class ToConferencePaperConversionRule implements ITypeConversionRule {
  readonly id = 'TO_CONFERENCE_PAPER_CONTAINER';
  readonly description = 'Maps container venue (publicationTitle / bookTitle) to proceedingsTitle when converting to conferencePaper';
  matches(s: string, t: string): boolean { return s !== 'conferencePaper' && t === 'conferencePaper'; }
  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.proceedingsTitle !== undefined) return;
    for (const c of ['publicationTitle', 'journal', 'bookTitle']) {
      if (remapFieldInContext(ctx, c, 'proceedingsTitle', 'base-semantic')) break;
    }
  }
}

class ToJournalArticleConversionRule implements ITypeConversionRule {
  readonly id = 'TO_JOURNAL_ARTICLE_CONTAINER';
  readonly description = 'Maps proceedingsTitle, bookTitle, or repository to publicationTitle when converting to journalArticle';
  matches(s: string, t: string): boolean { return s !== 'journalArticle' && t === 'journalArticle'; }
  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.publicationTitle !== undefined || ctx.sourceValues.journal !== undefined) return;
    const candidates = ctx.sourceType === 'preprint' ? ['proceedingsTitle', 'bookTitle'] : ['proceedingsTitle', 'bookTitle', 'repository'];
    for (const c of candidates) {
      if (remapFieldInContext(ctx, c, 'publicationTitle', 'base-semantic')) break;
    }
  }
}

class ToPreprintConversionRule implements ITypeConversionRule {
  readonly id = 'TO_PREPRINT_REPOSITORY';
  readonly description = 'Maps institution, publisher, or publicationTitle to repository when converting to preprint';
  matches(s: string, t: string): boolean { return s !== 'preprint' && t === 'preprint'; }
  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.repository !== undefined) return;
    for (const c of ['institution', 'publisher', 'publicationTitle']) {
      if (remapFieldInContext(ctx, c, 'repository', 'base-semantic')) break;
    }
  }
}

class ToThesisConversionRule implements ITypeConversionRule {
  readonly id = 'TO_THESIS_UNIVERSITY';
  readonly description = 'Maps publisher or institution to university when converting to thesis';
  matches(s: string, t: string): boolean { return s !== 'thesis' && t === 'thesis'; }
  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.university !== undefined) return;
    for (const c of ['institution', 'publisher']) {
      if (remapFieldInContext(ctx, c, 'university', 'base-semantic')) break;
    }
  }
}

class ToReportConversionRule implements ITypeConversionRule {
  readonly id = 'TO_REPORT_INSTITUTION';
  readonly description = 'Maps publisher or university to institution when converting to report';
  matches(s: string, t: string): boolean { return s !== 'report' && t === 'report'; }
  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.institution !== undefined) return;
    for (const c of ['publisher', 'university']) {
      if (remapFieldInContext(ctx, c, 'institution', 'base-semantic')) break;
    }
  }
}

class ToPatentConversionRule implements ITypeConversionRule {
  readonly id = 'TO_PATENT_AUTHORITY';
  readonly description = 'Maps place to country and authority/publisher to issuingAuthority when converting to patent';
  matches(s: string, t: string): boolean { return s !== 'patent' && t === 'patent'; }
  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.country === undefined) remapFieldInContext(ctx, 'place', 'country', 'base-semantic');
    if (ctx.sourceValues.issuingAuthority === undefined) {
      for (const c of ['authority', 'publisher', 'institution']) {
        if (remapFieldInContext(ctx, c, 'issuingAuthority', 'base-semantic')) break;
      }
    }
  }
}

class ToCaseConversionRule implements ITypeConversionRule {
  readonly id = 'TO_CASE_REPORTER_COURT';
  readonly description = 'Maps publicationTitle to reporter and authority/publisher to court when converting to legal case';
  matches(s: string, t: string): boolean { return s !== 'case' && t === 'case'; }
  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.reporter === undefined) remapFieldInContext(ctx, 'publicationTitle', 'reporter', 'base-semantic');
    if (ctx.sourceValues.court === undefined) {
      for (const c of ['authority', 'publisher']) {
        if (remapFieldInContext(ctx, c, 'court', 'base-semantic')) break;
      }
    }
  }
}

class ToStatuteConversionRule implements ITypeConversionRule {
  readonly id = 'TO_STATUTE_CODE';
  readonly description = 'Maps publicationTitle to code and volume to codeNumber when converting to statute';
  matches(s: string, t: string): boolean { return s !== 'statute' && t === 'statute'; }
  apply(ctx: TypeConversionRuleContext): void {
    if (ctx.sourceValues.code === undefined) remapFieldInContext(ctx, 'publicationTitle', 'code', 'base-semantic');
    if (ctx.sourceValues.codeNumber === undefined) remapFieldInContext(ctx, 'volume', 'codeNumber', 'base-semantic');
  }
}

const TYPE_CONVERSION_RULES: readonly ITypeConversionRule[] = [
  new BookToBookSectionConversionRule(), new BookSectionToBookConversionRule(),
  new ToConferencePaperConversionRule(), new ToJournalArticleConversionRule(),
  new ToPreprintConversionRule(), new ToThesisConversionRule(),
  new ToReportConversionRule(), new ToPatentConversionRule(),
  new ToCaseConversionRule(), new ToStatuteConversionRule(),
];

export function applyStructuralTypeConversionRules(
  sourceType: string, targetType: string,
  ctx: Omit<TypeConversionRuleContext, 'sourceType' | 'targetType'>,
  rules: readonly ITypeConversionRule[] = TYPE_CONVERSION_RULES,
): void {
  const fullContext: TypeConversionRuleContext = { sourceType, targetType, ...ctx };
  for (const rule of rules) {
    if (rule.matches(sourceType, targetType)) rule.apply(fullContext);
  }
}

export interface ITypeConversionSchemaPort {
  isValidItemType(itemType: string): boolean;
  isBibliographic(itemType: string): boolean;
  getOrderedFields(itemType: string): ItemFieldDefinition[];
  getValidCreatorTypes(itemType: string): CreatorTypeDefinition[];
  getPrimaryCreatorType(itemType: string): string;
  getBaseFieldMapping(itemType: string): Record<string, string>;
  resolveBaseFieldMapping(fromType: string, toType: string, fieldKey: string): { targetField: string; baseSemantic: string } | undefined;
}

function normalizeSchemaKey(key: string): string {
  if (!key) return key;
  if (SCHEMA_V42_DATA.itemTypes[key]) return key;
  const lower = key.toLowerCase();
  return Object.keys(SCHEMA_V42_DATA.itemTypes).find((k) => k.toLowerCase() === lower) || key;
}

export const DEFAULT_TYPE_CONVERSION_SCHEMA_PORT: ITypeConversionSchemaPort = {
  isValidItemType(itemType: string): boolean {
    return Boolean(itemType && Object.prototype.hasOwnProperty.call(SCHEMA_V42_DATA.itemTypes, normalizeSchemaKey(itemType)));
  },
  isBibliographic(itemType: string): boolean {
    return SCHEMA_V42_DATA.itemTypes[normalizeSchemaKey(itemType)]?.isBibliographic ?? false;
  },
  getOrderedFields(itemType: string): ItemFieldDefinition[] {
    const def = SCHEMA_V42_DATA.itemTypes[normalizeSchemaKey(itemType)];
    return def ? [...def.fields] : [];
  },
  getValidCreatorTypes(itemType: string): CreatorTypeDefinition[] {
    const def = SCHEMA_V42_DATA.itemTypes[normalizeSchemaKey(itemType)];
    return def ? [...def.creatorTypes] : [];
  },
  getPrimaryCreatorType(itemType: string): string {
    return SCHEMA_V42_DATA.itemTypes[normalizeSchemaKey(itemType)]?.primaryCreatorType ?? 'author';
  },
  getBaseFieldMapping(itemType: string): Record<string, string> {
    const norm = normalizeSchemaKey(itemType);
    return { ...getEffectiveBaseFieldMap(norm), ...(SCHEMA_V42_DATA.baseFieldMappings[norm] || {}) };
  },
  resolveBaseFieldMapping(fromType: string, toType: string, fieldKey: string): { targetField: string; baseSemantic: string } | undefined {
    const normFrom = normalizeSchemaKey(fromType), normTo = normalizeSchemaKey(toType);
    const reverseFrom = { ...getEffectiveReverseBaseFieldMap(normFrom), ...(SCHEMA_V42_DATA.reverseBaseFieldMappings[normFrom] || {}) };
    const baseField = reverseFrom[fieldKey] || fieldKey;
    if (!baseField) return undefined;
    const forwardTo = { ...getEffectiveBaseFieldMap(normTo), ...(SCHEMA_V42_DATA.baseFieldMappings[normTo] || {}) };
    const targetField = forwardTo[baseField] || baseField;
    return targetField ? { targetField, baseSemantic: baseField } : undefined;
  },
};

/**
 * Retrieves an item's field value considering top-level properties, `extraFields`,
 * field aliases, `__unmapped_<sourceType>_<field>` tombstones, and Zotero `Extra` lines.
 */
export function getItemFieldValueWithTombstones(item: Record<string, unknown>, key: string): unknown {
  if (!item) return undefined;
  if (item[key] !== undefined && item[key] !== null && item[key] !== '') return item[key];
  if (item.extraFields && typeof item.extraFields === 'object') {
    const extra = item.extraFields as Record<string, unknown>;
    if (extra[key] !== undefined && extra[key] !== null && extra[key] !== '') return extra[key];
  }
  const alias = FIELD_ALIASES[key] || REVERSE_FIELD_ALIASES[key];
  if (alias) {
    if (item[alias] !== undefined && item[alias] !== null && item[alias] !== '') return item[alias];
    if (item.extraFields && typeof item.extraFields === 'object') {
      const ef = item.extraFields as Record<string, unknown>;
      if (ef[alias] !== undefined && ef[alias] !== null && ef[alias] !== '') return ef[alias];
    }
  }
  const lowerKey = key.toLowerCase();
  for (const [k, v] of Object.entries(item)) {
    if (k.toLowerCase() === lowerKey && v !== undefined && v !== null && v !== '') return v;
  }
  if (item.extraFields && typeof item.extraFields === 'object') {
    for (const [k, v] of Object.entries(item.extraFields as Record<string, unknown>)) {
      if (k.toLowerCase() === lowerKey && v !== undefined && v !== null && v !== '') return v;
    }
  }
  const candidateSuffixes = new Set<string>([lowerKey, ...(alias ? [alias.toLowerCase()] : [])]);
  let unmappedVal: unknown, unmappedSuffix: string | undefined;
  for (const container of [item.extraFields, item.metadata]) {
    if (!container || typeof container !== 'object' || Array.isArray(container)) continue;
    for (const [k, v] of Object.entries(container as Record<string, unknown>)) {
      if (v === undefined || v === null || v === '') continue;
      const m = k.match(/^__unmapped_[^_]+_(.+)$/i);
      if (m && m[1] && candidateSuffixes.has(m[1].toLowerCase())) {
        unmappedVal = v;
        unmappedSuffix = m[1];
        break;
      }
    }
    if (unmappedVal !== undefined) break;
  }
  if (typeof item.extra === 'string' && item.extra.trim()) {
    const targetNorms = new Set<string>();
    for (const s of candidateSuffixes) targetNorms.add(s.replace(/[\s_-]+/g, ''));
    if (unmappedSuffix) targetNorms.add(unmappedSuffix.toLowerCase().replace(/[\s_-]+/g, ''));
    for (const rawLine of item.extra.split(/\r?\n/)) {
      const kv = rawLine.trim().match(/^([A-Za-z_][A-Za-z0-9._\s-]{0,40}?)\s*:\s*(.+)$/);
      if (!kv || !kv[1] || !kv[2]) continue;
      const kNorm = kv[1].trim().toLowerCase().replace(/[\s_-]+/g, '');
      if (targetNorms.has(kNorm)) return kv[2].trim();
    }
  }
  return unmappedVal;
}

export function findMatchingTargetFieldInSchema(sourceKey: string, targetFields: ItemFieldDefinition[]): string | undefined {
  const exact = targetFields.find((f) => f.key === sourceKey);
  if (exact) return exact.key;
  const targetAlias = FIELD_ALIASES[sourceKey] || REVERSE_FIELD_ALIASES[sourceKey];
  if (targetAlias) {
    const matched = targetFields.find((f) => f.key === targetAlias);
    if (matched) return matched.key;
  }
  const lowerSource = sourceKey.toLowerCase();
  return targetFields.find((f) => f.key.toLowerCase() === lowerSource)?.key;
}

const TYPE_SPECIFIC_COLUMN_KEYS = new Set([
  'isbn', 'ISBN', 'issn', 'ISSN', 'publicationTitle', 'journal', 'journalAbbr',
  'journalAbbreviation', 'publisher', 'place', 'volume', 'issue', 'pages',
  'series', 'seriesTitle', 'seriesText', 'seriesNumber', 'edition', 'section', 'partNumber', 'partTitle',
]);
const ALL_PRIMARY_CREATOR_ROLES = new Set([
  'author', 'director', 'interviewer', 'podcaster', 'inventor', 'programmer',
  'artist', 'cartographer', 'composer', 'performer', 'presenter', 'sponsor',
]);
const ALWAYS_PRESERVED_CORE_FIELDS = new Set([
  'title', 'abstract', 'abstractNote', 'date', 'year', 'url', 'doi', 'DOI', 'extra', 'citationKey',
]);

/**
 * Pure deterministic preview of item-type conversion with Base Field remapping
 * and Unmapped Field Tombstones (`__unmapped_<sourceType>_<field>` preservation & restoration).
 */
export function previewItemTypeConversion(
  rawItem: unknown,
  targetType: string,
  options: { retainUnmappedInExtra?: boolean } = {},
  schemaPort: ITypeConversionSchemaPort = DEFAULT_TYPE_CONVERSION_SCHEMA_PORT,
): TypeConversionPreview {
  const item = ItemsMapper.toDomain(rawItem) as Record<string, unknown>;
  const sourceType = (item.itemType || item.type || 'journalArticle') as string;

  if (sourceType === targetType) {
    return {
      sourceType, targetType,
      preservedFields: schemaPort.getOrderedFields(sourceType).map((f) => f.key),
      mappedFields: [], droppedFields: [], newAvailableFields: [],
      schemaUnsupportedFields: [], schemaUnsupportedFieldLabels: [],
      creatorChanges: ((Array.isArray(item.creators) ? item.creators : []) as Array<Record<string, unknown>>).map((c) => ({
        creator: c, fromRole: (c.creatorType as string) || 'author',
        toRole: (c.creatorType as string) || 'author', reason: 'preserved' as const,
      })),
      projectedItem: { ...item }, unmappedRetained: {}, hasLoss: false,
    };
  }

  const sourceFields = schemaPort.getOrderedFields(sourceType);
  const targetFields = schemaPort.getOrderedFields(targetType);
  const targetFieldKeys = new Set(targetFields.map((f) => f.key));
  const sourceLabelMap = new Map(sourceFields.map((f) => [f.key, f.label]));
  const targetLabelMap = new Map(targetFields.map((f) => [f.key, f.label]));

  const preservedFields: string[] = [];
  const mappedFields: FieldMappingChange[] = [];
  const droppedFields: DroppedField[] = [];
  const unmappedRetained: Record<string, unknown> = {};
  const recoveredExtraLineNorms = new Set<string>();
  const projectedItem: Record<string, unknown> = { ...item, itemType: targetType, type: targetType };

  const sourceValues: Record<string, unknown> = {};
  for (const field of sourceFields) {
    const val = getItemFieldValueWithTombstones(item, field.key);
    if (val !== undefined && val !== null && val !== '') sourceValues[field.key] = val;
  }

  const sourceBaseMap = schemaPort.getBaseFieldMapping(sourceType);
  const persistentAcademicKeys = Array.from(
    new Set([
      ...ITEM_COLUMN_METADATA_FIELDS, ...Object.keys(FIELD_ALIASES), ...targetFields.map((f) => f.key),
      'title', 'abstract', 'abstractNote', 'date', 'year', 'url', 'extra', 'citationKey',
    ]),
  );
  for (const k of persistentAcademicKeys) {
    if (k === 'itemType' || k === 'type') continue;
    const val = getItemFieldValueWithTombstones(item, k);
    if (val !== undefined && val !== null && val !== '') {
      const canonicalKey = FIELD_ALIASES[k] ? k : REVERSE_FIELD_ALIASES[k] || k;
      const baseKey = FIELD_ALIASES[k] || k;
      const mappedSourceField = sourceBaseMap[k] || sourceBaseMap[baseKey] || sourceBaseMap[canonicalKey] || (baseKey === 'issue' ? sourceBaseMap.number : undefined);
      if (mappedSourceField && mappedSourceField !== canonicalKey && sourceValues[mappedSourceField] !== undefined) continue;
      if (sourceValues[canonicalKey] === undefined && sourceValues[k] === undefined) sourceValues[canonicalKey] = val;
    }
  }

  for (const field of sourceFields) {
    if (!findMatchingTargetFieldInSchema(field.key, targetFields) && !ALWAYS_PRESERVED_CORE_FIELDS.has(field.key)) {
      delete projectedItem[field.key];
    }
  }

  const newExtraFields: Record<string, unknown> = { ...((item.extraFields as Record<string, unknown> | undefined) || {}) };
  delete newExtraFields.itemType;
  delete newExtraFields.type;

  applyStructuralTypeConversionRules(sourceType, targetType, {
    sourceValues, projectedItem, mappedFields, droppedFields,
    unmappedRetained, newExtraFields, retainUnmappedInExtra: options.retainUnmappedInExtra !== false,
  });
  if (projectedItem.shortTitle === undefined) delete newExtraFields.shortTitle;

  const removeRecoveredUnmappedField = (keys: string[]) => {
    const lowerSet = new Set<string>();
    for (const k of keys) {
      if (!k) continue;
      lowerSet.add(k.toLowerCase());
      recoveredExtraLineNorms.add(k.toLowerCase().replace(/[\s_-]+/g, ''));
      const lbl = targetLabelMap.get(k) || sourceLabelMap.get(k);
      if (lbl) recoveredExtraLineNorms.add(String(lbl).toLowerCase().replace(/[\s_-]+/g, ''));
      const alias = FIELD_ALIASES[k] || REVERSE_FIELD_ALIASES[k];
      if (alias) {
        lowerSet.add(alias.toLowerCase());
        recoveredExtraLineNorms.add(alias.toLowerCase().replace(/[\s_-]+/g, ''));
        const aliasLbl = targetLabelMap.get(alias) || sourceLabelMap.get(alias);
        if (aliasLbl) recoveredExtraLineNorms.add(String(aliasLbl).toLowerCase().replace(/[\s_-]+/g, ''));
      }
    }
    for (const efKey of Object.keys(newExtraFields)) {
      const m = efKey.match(/^__unmapped_[^_]+_(.+)$/i);
      if (m && m[1] && lowerSet.has(m[1].toLowerCase())) {
        delete newExtraFields[efKey];
        const suffix = m[1];
        recoveredExtraLineNorms.add(suffix.toLowerCase().replace(/[\s_-]+/g, ''));
        const lbl = targetLabelMap.get(suffix) || sourceLabelMap.get(suffix) || keys.map((k) => targetLabelMap.get(k) || sourceLabelMap.get(k)).find(Boolean);
        if (lbl) recoveredExtraLineNorms.add(String(lbl).toLowerCase().replace(/[\s_-]+/g, ''));
      }
    }
  };

  for (const mapped of mappedFields) removeRecoveredUnmappedField([mapped.fromField, mapped.toField]);
  for (const tField of targetFields) removeRecoveredUnmappedField([tField.key]);

  for (const [sField, val] of Object.entries(sourceValues)) {
    const matchedTargetKey = findMatchingTargetFieldInSchema(sField, targetFields);
    if (matchedTargetKey) {
      projectedItem[matchedTargetKey] = val;
      const dbCol = FIELD_ALIASES[matchedTargetKey];
      if (dbCol) projectedItem[dbCol] = val;
      removeRecoveredUnmappedField([sField, matchedTargetKey]);
      preservedFields.push(matchedTargetKey);
    } else {
      const resolved = schemaPort.resolveBaseFieldMapping(sourceType, targetType, sField);
      if (resolved?.targetField && targetFieldKeys.has(resolved.targetField)) {
        projectedItem[resolved.targetField] = val;
        const dbCol = FIELD_ALIASES[resolved.targetField];
        if (dbCol) projectedItem[dbCol] = val;
        delete projectedItem[sField];
        delete newExtraFields[sField];
        removeRecoveredUnmappedField([sField, resolved.targetField]);
        mappedFields.push({ fromField: sField, toField: resolved.targetField, value: val, rule: 'base-semantic' });
      } else {
        const isPersistentCol = (ITEM_COLUMN_METADATA_FIELDS.has(sField) || ITEM_COLUMN_METADATA_FIELDS.has(FIELD_ALIASES[sField])) && !TYPE_SPECIFIC_COLUMN_KEYS.has(sField);
        if (isPersistentCol) {
          projectedItem[sField] = val;
          const dbCol = FIELD_ALIASES[sField];
          if (dbCol) projectedItem[dbCol] = val;
          preservedFields.push(sField);
        } else {
          delete projectedItem[sField];
          delete newExtraFields[sField];
          const aliasKey = FIELD_ALIASES[sField] || REVERSE_FIELD_ALIASES[sField];
          if (aliasKey) {
            delete projectedItem[aliasKey];
            delete newExtraFields[aliasKey];
          }
          droppedFields.push({ field: sField, label: String(sourceLabelMap.get(sField) || sField), value: val });
          unmappedRetained[sField] = val;
          if (options.retainUnmappedInExtra !== false) newExtraFields[`__unmapped_${sourceType}_${sField}`] = val;
        }
      }
    }
  }

  if (projectedItem.metadata && typeof projectedItem.metadata === 'object' && !Array.isArray(projectedItem.metadata)) {
    const cleanedMeta: Record<string, unknown> = { ...(projectedItem.metadata as Record<string, unknown>) };
    for (const dropped of droppedFields) {
      delete cleanedMeta[dropped.field];
      const aliasKey = FIELD_ALIASES[dropped.field] || REVERSE_FIELD_ALIASES[dropped.field];
      if (aliasKey) delete cleanedMeta[aliasKey];
    }
    for (const mapped of mappedFields) {
      if (mapped.fromField !== mapped.toField) {
        delete cleanedMeta[mapped.fromField];
        const aliasKey = FIELD_ALIASES[mapped.fromField] || REVERSE_FIELD_ALIASES[mapped.fromField];
        if (aliasKey && aliasKey !== mapped.toField) delete cleanedMeta[aliasKey];
      }
    }
    for (const mk of Object.keys(cleanedMeta)) {
      const m = mk.match(/^__unmapped_[^_]+_(.+)$/i);
      if (m && m[1] && recoveredExtraLineNorms.has(m[1].toLowerCase().replace(/[\s_-]+/g, ''))) delete cleanedMeta[mk];
    }
    projectedItem.metadata = cleanedMeta;
  }

  projectedItem.extraFields = newExtraFields;

  if (recoveredExtraLineNorms.size > 0 && typeof projectedItem.extra === 'string' && projectedItem.extra.trim()) {
    const filteredLines = projectedItem.extra.split(/\r?\n/).filter((line) => {
      const kv = line.trim().match(/^([A-Za-z_][A-Za-z0-9._\s-]{0,40}?)\s*:\s*(.+)$/);
      if (!kv || !kv[1]) return true;
      return !recoveredExtraLineNorms.has(kv[1].trim().toLowerCase().replace(/[\s_-]+/g, ''));
    });
    projectedItem.extra = filteredLines.join('\n').trim();
  }

  if (options.retainUnmappedInExtra !== false && droppedFields.length > 0) {
    const extraLines: string[] = [];
    const currentExtra = projectedItem.extra || item.extra;
    if (currentExtra && typeof currentExtra === 'string' && currentExtra.trim()) extraLines.push(currentExtra.trim());
    const existingLineSet = new Set(extraLines.flatMap((block) => block.split(/\r?\n/)).map((l) => l.trim().toLowerCase()).filter(Boolean));
    for (const dropped of droppedFields) {
      if ((typeof dropped.value === 'string' && dropped.value !== '') || typeof dropped.value === 'number' || typeof dropped.value === 'boolean') {
        const candidateLine = `${dropped.label || dropped.field}: ${String(dropped.value)}`;
        const candidateLower = candidateLine.trim().toLowerCase();
        if (!existingLineSet.has(candidateLower)) {
          existingLineSet.add(candidateLower);
          extraLines.push(candidateLine);
        }
      }
    }
    if (extraLines.length > 0) projectedItem.extra = extraLines.join('\n');
  }

  const validCreatorRoles = new Set(schemaPort.getValidCreatorTypes(targetType).map((c) => c.creatorType));
  const sourcePrimaryCreator = schemaPort.getPrimaryCreatorType(sourceType);
  const targetPrimaryCreator = schemaPort.getPrimaryCreatorType(targetType);
  const allPrimaryCreatorRoles = new Set([...ALL_PRIMARY_CREATOR_ROLES, sourcePrimaryCreator]);
  const creatorChanges: CreatorRoleChange[] = [];

  const rawSourceCreators = (
    Array.isArray(item.creators) && item.creators.length > 0 ? item.creators : Array.isArray(item.contributors) ? item.contributors : []
  ) as Array<Record<string, unknown>>;

  const projectedCreators = rawSourceCreators.map((c, index) => {
    const fromRole = (c.creatorType as string) || (c.role as string) || 'author';
    let toRole: string = fromRole;
    let reason: 'preserved' | 'primary-fallback' | 'secondary-fallback' = 'preserved';
    if (!validCreatorRoles.has(fromRole)) {
      if ((allPrimaryCreatorRoles.has(fromRole) || index === 0) && validCreatorRoles.has(targetPrimaryCreator)) {
        toRole = targetPrimaryCreator;
        reason = 'primary-fallback';
      } else if (validCreatorRoles.has('contributor')) {
        toRole = 'contributor';
        reason = 'secondary-fallback';
      } else {
        toRole = targetPrimaryCreator;
        reason = 'primary-fallback';
      }
    }
    creatorChanges.push({ creator: c, fromRole, toRole, reason });
    return { ...c, creatorType: toRole, role: toRole };
  });

  projectedItem.itemType = targetType;
  projectedItem.type = targetType;
  projectedItem.creators = projectedCreators;

  const hasLoss = droppedFields.length > 0 || creatorChanges.some((c) => c.reason !== 'preserved');
  const sourceFieldKeySet = new Set(sourceFields.map((f) => f.key));
  const preservedOrMappedTargetKeySet = new Set([...preservedFields, ...mappedFields.map((m) => m.toField)]);
  const newAvailableFields = targetFields.map((f) => f.key).filter((tKey) => {
    if (sourceFieldKeySet.has(tKey) || preservedOrMappedTargetKeySet.has(tKey)) return false;
    const val = getItemFieldValueWithTombstones(item, tKey);
    return val === undefined || val === null || val === '';
  });

  const schemaUnsupportedFieldDefs = sourceFields.filter((sf) => {
    if (ALWAYS_PRESERVED_CORE_FIELDS.has(sf.key)) return false;
    if (findMatchingTargetFieldInSchema(sf.key, targetFields)) return false;
    const resolved = schemaPort.resolveBaseFieldMapping(sourceType, targetType, sf.key);
    return !(resolved?.targetField && targetFieldKeys.has(resolved.targetField));
  });

  return {
    sourceType, targetType, preservedFields: Array.from(new Set(preservedFields)),
    mappedFields, droppedFields, newAvailableFields,
    schemaUnsupportedFields: schemaUnsupportedFieldDefs.map((sf) => sf.key),
    schemaUnsupportedFieldLabels: schemaUnsupportedFieldDefs.map((sf) => String(sf.label || sf.key)),
    creatorChanges, projectedItem, unmappedRetained, hasLoss,
  };
}

/**
 * Builds the transactional persistence payload for an item-type conversion, including
 * `__unmapped_<sourceType>_<field>` tombstone management and provenance transfer.
 */
export function buildTypeConversionUpdatePayload(
  targetType: string,
  existing: ItemDetail,
  preview: TypeConversionPreview,
  targetFields: ItemFieldDefinition[] = DEFAULT_TYPE_CONVERSION_SCHEMA_PORT.getOrderedFields(targetType),
  fieldReader?: { getItemFieldValue(item: Record<string, unknown>, key: string): unknown },
  options?: { retainUnmappedInExtra?: boolean },
): Record<string, unknown> {
  const readField = (rec: Record<string, unknown>, key: string): unknown =>
    fieldReader ? fieldReader.getItemFieldValue(rec, key) : getItemFieldValueWithTombstones(rec, key);

  const projected = preview.projectedItem;
  const dynamicExtraFields: Record<string, unknown> = { ...((projected.extraFields as Record<string, unknown> | undefined) || {}) };
  delete dynamicExtraFields.itemType;
  delete dynamicExtraFields.type;

  const targetFieldKeySet = new Set(targetFields.map((f) => f.key));
  const droppedSet = new Set(preview.droppedFields.map((d) => d.field.toLowerCase()));
  const mappedOutSet = new Set(
    preview.mappedFields.filter((m) => m.fromField.toLowerCase() !== m.toField.toLowerCase()).map((m) => m.fromField.toLowerCase()),
  );

  for (const dropped of preview.droppedFields) {
    dynamicExtraFields[dropped.field] = null;
    const aliasKey = FIELD_ALIASES[dropped.field] || REVERSE_FIELD_ALIASES[dropped.field];
    if (aliasKey && !targetFieldKeySet.has(aliasKey)) dynamicExtraFields[aliasKey] = null;
  }
  for (const mapped of preview.mappedFields) {
    if (mapped.fromField !== mapped.toField) {
      dynamicExtraFields[mapped.fromField] = null;
      const aliasKey = FIELD_ALIASES[mapped.fromField] || REVERSE_FIELD_ALIASES[mapped.fromField];
      if (aliasKey && aliasKey !== mapped.toField) dynamicExtraFields[aliasKey] = null;
    }
  }
  for (const field of targetFields) {
    const val = readField(projected, field.key);
    if (val !== undefined && val !== null && val !== '' && !ITEM_COLUMN_METADATA_FIELDS.has(field.key) && !ITEM_COLUMN_METADATA_FIELDS.has(FIELD_ALIASES[field.key])) {
      dynamicExtraFields[field.key] = val;
    }
  }

  const metadataPatch: Record<string, unknown> = {};
  for (const dropped of preview.droppedFields) {
    metadataPatch[dropped.field] = null;
    const aliasKey = FIELD_ALIASES[dropped.field] || REVERSE_FIELD_ALIASES[dropped.field];
    if (aliasKey && !targetFieldKeySet.has(aliasKey)) metadataPatch[aliasKey] = null;
  }
  for (const mapped of preview.mappedFields) {
    if (mapped.fromField !== mapped.toField) {
      metadataPatch[mapped.fromField] = null;
      const aliasKey = FIELD_ALIASES[mapped.fromField] || REVERSE_FIELD_ALIASES[mapped.fromField];
      if (aliasKey && aliasKey !== mapped.toField) metadataPatch[aliasKey] = null;
    }
  }

  const existingRec = existing as unknown as Record<string, unknown>;
  const existingMetaRec = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata) ? (existing.metadata as Record<string, unknown>) : {};
  const existingExtraRec = existing.extraFields && typeof existing.extraFields === 'object' && !Array.isArray(existing.extraFields) ? existing.extraFields : {};

  if (options?.retainUnmappedInExtra === false) {
    for (const container of [existingMetaRec, existingExtraRec, dynamicExtraFields]) {
      for (const k of Object.keys(container)) {
        if (/^__unmapped_/i.test(k)) {
          dynamicExtraFields[k] = null;
          metadataPatch[k] = null;
        }
      }
    }
    for (const dropped of preview.droppedFields) {
      const unmappedKey = `__unmapped_${preview.sourceType}_${dropped.field}`;
      dynamicExtraFields[unmappedKey] = null;
      metadataPatch[unmappedKey] = null;
    }
  } else {
    for (const k of new Set([...Object.keys(existingMetaRec), ...Object.keys(existingExtraRec)])) {
      if (/^__unmapped_/i.test(k) && dynamicExtraFields[k] === undefined) {
        dynamicExtraFields[k] = null;
        metadataPatch[k] = null;
      }
    }
    for (const [k, v] of Object.entries(dynamicExtraFields)) {
      if (/^__unmapped_/i.test(k) && v !== null && v !== undefined) metadataPatch[k] = v;
    }
  }

  const hadShortTitle = Boolean(existingRec.shortTitle || existingMetaRec.shortTitle || existingExtraRec.shortTitle);
  const projectedShortTitle = readField(projected, 'shortTitle');
  if (hadShortTitle && (projectedShortTitle === undefined || projectedShortTitle === null || projectedShortTitle === '')) {
    dynamicExtraFields.shortTitle = null;
    metadataPatch.shortTitle = null;
  }

  const { fieldProvenance, lockedFields } = ItemProvenancePolicy.transferConversionProvenance(existing, preview);
  metadataPatch.fieldProvenance = fieldProvenance;
  metadataPatch.lockedFields = lockedFields;

  const updatePayload: Record<string, unknown> = {
    __isSystemUpdate: true,
    itemType: targetType,
    type: targetType,
    creators: projected.creators ?? existing.creators,
    contributors: projected.creators ?? existing.contributors ?? existing.creators,
    extraFields: dynamicExtraFields,
    ...(projected.extra !== undefined ? { extra: projected.extra } : {}),
    metadata: metadataPatch,
  };

  const targetBaseMap = getEffectiveBaseFieldMap(targetType);
  for (const col of ITEM_COLUMN_METADATA_FIELDS) {
    if (FIELD_ALIASES[col] && FIELD_ALIASES[col] !== col) continue;
    const colLower = col.toLowerCase();
    if (droppedSet.has(colLower) || mappedOutSet.has(colLower)) {
      updatePayload[col] = null;
    } else {
      const mappedTargetField = targetBaseMap[col] || (col === 'issue' ? targetBaseMap.number : undefined);
      const val = readField(projected, col) ?? (mappedTargetField ? readField(projected, mappedTargetField) : undefined);
      if (val !== undefined && val !== null && val !== '') updatePayload[col] = val;
      else if (col !== 'title' && col !== 'itemType') updatePayload[col] = null;
    }
  }

  return updatePayload;
}
