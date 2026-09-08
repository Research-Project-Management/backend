import {
  SCHEMA_V42_DATA,
  LIBRARY_SCHEMA_VERSION,
  ALL_CREATOR_ROLES,
  BASE_FIELD_MAPPINGS,
} from '../../src/modules/library/types/constants/types.constants';

describe('Official Zotero Schema (v42) Ground Truth Verification', () => {
  it('should load official schema version 42 with exactly 40 item types', () => {
    expect(LIBRARY_SCHEMA_VERSION).toBe(42);
    expect(SCHEMA_V42_DATA.version).toBe(42);
    expect(SCHEMA_V42_DATA.source).toBe('zotero-schema-v42');
    expect(Object.keys(SCHEMA_V42_DATA.itemTypes)).toHaveLength(40);
  });

  it('should accurately define preprint item type conforming to Zotero desktop standard', () => {
    const preprint = SCHEMA_V42_DATA.itemTypes.preprint;
    expect(preprint).toBeDefined();
    expect(preprint.label).toBe('Preprint');
    expect(preprint.category).toBe('academic');
    expect(preprint.isBibliographic).toBe(true);

    // 21 fields in official order
    expect(preprint.fields).toHaveLength(21);

    const fieldKeys = preprint.fields.map((f) => f.key);
    expect(fieldKeys).toEqual([
      'title',
      'abstractNote',
      'genre',
      'repository',
      'archiveID',
      'place',
      'date',
      'series',
      'seriesNumber',
      'DOI',
      'citationKey',
      'url',
      'accessDate',
      'archive',
      'archiveLocation',
      'shortTitle',
      'language',
      'libraryCatalog',
      'callNumber',
      'rights',
      'extra',
    ]);

    // Check key localized labels
    const archiveIdField = preprint.fields.find((f) => f.key === 'archiveID');
    expect(archiveIdField?.label).toBe('Archive ID');
    expect(archiveIdField?.baseField).toBe('number');
    expect(archiveIdField?.mono).toBe(true);

    const rightsField = preprint.fields.find((f) => f.key === 'rights');
    expect(rightsField?.label).toBe('License');

    const abstractField = preprint.fields.find((f) => f.key === 'abstractNote');
    expect(abstractField?.label).toBe('Abstract');

    const accessDateField = preprint.fields.find((f) => f.key === 'accessDate');
    expect(accessDateField?.label).toBe('Accessed');

    // Creator types
    const creatorRoles = preprint.creatorTypes.map((c) => c.creatorType);
    expect(creatorRoles).toEqual([
      'author',
      'contributor',
      'editor',
      'translator',
      'reviewedAuthor',
    ]);
    expect(preprint.primaryCreatorType).toBe('author');
  });

  it('should accurately define journalArticle item type conforming to Zotero desktop standard', () => {
    const journalArticle = SCHEMA_V42_DATA.itemTypes.journalArticle;
    expect(journalArticle).toBeDefined();
    expect(journalArticle.label).toBe('Journal Article');
    expect(journalArticle.fields).toHaveLength(31);

    const publicationField = journalArticle.fields.find((f) => f.key === 'publicationTitle');
    expect(publicationField?.label).toBe('Publication');

    const journalAbbrField = journalArticle.fields.find((f) => f.key === 'journalAbbreviation');
    expect(journalAbbrField?.label).toBe('Journal Abbr');
  });

  it('should extract correct baseFieldMappings from official schema', () => {
    expect(BASE_FIELD_MAPPINGS.preprint).toEqual({
      type: 'genre',
      publisher: 'repository',
      number: 'archiveID',
    });

    expect(BASE_FIELD_MAPPINGS.conferencePaper).toEqual({
      publicationTitle: 'proceedingsTitle',
    });

    expect(BASE_FIELD_MAPPINGS.bookSection).toEqual({
      publicationTitle: 'bookTitle',
      medium: 'format',
    });
  });

  it('should expose complete creator roles dictionary', () => {
    expect(Object.keys(ALL_CREATOR_ROLES).length).toBeGreaterThanOrEqual(30);
    expect(ALL_CREATOR_ROLES.author).toBe('Author');
    expect(ALL_CREATOR_ROLES.editor).toBe('Editor');
    expect(ALL_CREATOR_ROLES.reviewedAuthor).toBe('Reviewed Author');
  });
});
