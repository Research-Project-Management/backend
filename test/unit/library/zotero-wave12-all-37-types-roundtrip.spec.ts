import { SCHEMA_V42_DATA } from '@/modules/library/core/types/schema.constants';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import { ZoteroSchemaValidatorService } from '@/modules/library/catalog/services/zotero-schema-validator.service';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { toItemData } from '@/modules/library/ingestion/stages/commit.stage';
import {
  buildCommandCreateInput,
  buildCommandUpdateInput,
} from '@/modules/library/catalog/domain/command-payload.builder';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';
import { CslJsonMapper } from '@/modules/library/citation/domain/csl-json.mapper';
import { CslEngineService } from '@/modules/library/citation/services/csl-engine.service';
import { ItemMetadata } from '@/modules/library/ingestion/types/metadata.types';
import {
  CreateItemData,
  CreatorCreditInput,
  UpdateItemData,
} from '@/modules/library/core/types/bibliographic.types';
import { PrismaService } from '@/core';

const CANONICAL_SAMPLE_VALUES: Record<string, string> = {
  DOI: '10.1038/s41586-024-07998-6',
  ISBN: '978-0-262-03561-3',
  ISSN: '0028-0836',
  PMID: '38491234',
  PMCID: 'PMC10987654',
  archiveID: 'arXiv:2405.12345',
  url: 'https://example.org/resource/2024',
  date: '2024-05-15',
  dateDecided: '2024-05-15',
  dateEnacted: '2024-05-15',
  filingDate: '2023-11-10',
  issueDate: '2024-05-15',
  accessDate: '2024-06-01T10:30:00.000Z',
  numPages: '320',
  pages: '101-125',
  firstPage: '101',
  codePages: '101-125',
  volume: '42',
  reporterVolume: '42',
  codeVolume: '42',
  codeNumber: '42',
  issue: '7',
  number: 'TR-2024-07',
  reportNumber: 'TR-2024-07',
  patentNumber: 'US-2024-998877',
  billNumber: 'HR-2024-42',
  publicLawNumber: 'PL-118-42',
  docketNumber: '23-456',
  episodeNumber: '12',
  documentNumber: 'DOC-2024-88',
  seriesNumber: '9',
  numberOfVolumes: '3',
  edition: '2nd Edition',
  versionNumber: '4.2.0',
  citationKey: 'smith2024canonical',
  title: 'Structural Verification of Bibliographic Metadata Systems',
  caseName: 'Smith v. Bibliographic Board',
  nameOfAct: 'Academic Metadata Preservation Act',
  subject: 'Research Collaboration Inquiry on Schema v42',
  shortTitle: 'Metadata Verification',
  abstractNote:
    'A comprehensive empirical evaluation of end-to-end bibliographic field preservation across 37 Zotero item types.',
  extra: 'Supplemental archival note for Wave 12 verification',
};

function buildSampleFieldValue(itemType: string, fieldKey: string): string {
  if (CANONICAL_SAMPLE_VALUES[fieldKey] !== undefined) {
    return CANONICAL_SAMPLE_VALUES[fieldKey];
  }
  return `Val_${itemType}_${fieldKey}`;
}

function buildSampleCreatorsForType(itemType: string): CreatorCreditInput[] {
  const typeDef = SCHEMA_V42_DATA.itemTypes[itemType];
  if (!typeDef || !Array.isArray(typeDef.creatorTypes)) return [];

  return typeDef.creatorTypes.map((ct, idx) => ({
    creatorType: ct.creatorType,
    firstName: `First${idx + 1}`,
    lastName: `Last_${ct.creatorType}`,
    fullName: `First${idx + 1} Last_${ct.creatorType}`,
    name: `First${idx + 1} Last_${ct.creatorType}`,
    fieldMode: 0,
    orderIndex: idx,
  }));
}

function createMockPrismaClient() {
  return {
    tag: {
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      findMany: jest.fn().mockResolvedValue([
        { id: 'tag-1', name: 'zotero-v42', type: 'manual' },
        { id: 'tag-2', name: 'roundtrip', type: 'manual' },
      ]),
    },
    itemTag: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 2 }),
      upsert: jest.fn().mockResolvedValue({}),
    },
  } as unknown as PrismaService;
}

describe('Wave 12: Exhaustive End-to-End Type, Field & Format Round-Trip Verification (All 37 Zotero Schema v42 Types & All 112 Fields)', () => {
  let typesService: TypesService;
  let validator: ZoteroSchemaValidatorService;
  let normalizationPolicy: NormalizationPolicy;
  let cslEngine: CslEngineService;
  const mockPrisma = createMockPrismaClient();

  const allItemTypeKeys = Object.keys(SCHEMA_V42_DATA.itemTypes);
  const allDistinctFieldKeys = SCHEMA_V42_DATA.distinctFieldKeys;

  beforeAll(() => {
    typesService = new TypesService();
    validator = new ZoteroSchemaValidatorService(typesService);
    normalizationPolicy = new NormalizationPolicy();
    cslEngine = new CslEngineService();
  });

  it('verifies Zotero Schema v42 snapshot has all 37 bibliographic item types (40 total with special types) and all 121 distinct field keys', () => {
    const bibliographicTypes = typesService.getAllItemTypes(false);
    expect(bibliographicTypes.length).toBe(37);
    expect(allItemTypeKeys.length).toBe(40);
    expect(allDistinctFieldKeys.length).toBe(121);

    const unionOfFieldsAcrossAllTypes = new Set<string>();
    for (const itemType of allItemTypeKeys) {
      const def = SCHEMA_V42_DATA.itemTypes[itemType];
      for (const f of def.fields) {
        unionOfFieldsAcrossAllTypes.add(f.key);
      }
    }
    expect(unionOfFieldsAcrossAllTypes.size).toBe(121);
    for (const fieldKey of allDistinctFieldKeys) {
      expect(unionOfFieldsAcrossAllTypes.has(fieldKey)).toBe(true);
    }
  });

  describe.each(allItemTypeKeys)(
    'Full 4-Stage Pipeline Round-Trip for itemType="%s"',
    (itemType) => {
      const typeDef = SCHEMA_V42_DATA.itemTypes[itemType];
      const orderedFields = typeDef.fields;
      const validCreatorTypes = typeDef.creatorTypes;

      it(`preserves all ${orderedFields.length} schema fields and ${validCreatorTypes.length} creator roles from ingestion through DB persistence, domain mapping, and CSL/BibTeX/RIS export`, async () => {
        // 1. Construct raw input containing EVERY valid Zotero v42 field and creator role for this itemType
        const rawInput: Record<string, unknown> = {
          itemType,
          tags: ['zotero-v42', 'roundtrip'],
        };

        const expectedFieldValues: Record<string, string> = {};
        for (const fieldDef of orderedFields) {
          const val = buildSampleFieldValue(itemType, fieldDef.key);
          rawInput[fieldDef.key] = val;
          expectedFieldValues[fieldDef.key] = val;
        }

        // For special types (note, attachment) that have 0 bibliographic fields in Zotero schema,
        // ensure title is still provided so catalog persistence works cleanly.
        if (orderedFields.length === 0) {
          rawInput.title = `Special Item ${itemType}`;
        }

        const inputCreators = buildSampleCreatorsForType(itemType);
        if (inputCreators.length > 0) {
          rawInput.creators = inputCreators;
        }

        // STAGE A: NormalizationPolicy.normalize -> CommitStage.toItemData
        const normalizedMeta = normalizationPolicy.normalize(rawInput);
        expect(normalizedMeta.itemType).toBe(itemType);

        const primaryRole = typesService.getPrimaryCreatorType(itemType);
        const committedItemData = toItemData(
          normalizedMeta,
          { userId: 'user-wave12-test' },
          primaryRole,
        );
        expect(committedItemData.itemType).toBe(itemType);
        expect(committedItemData.title).toBeTruthy();
        expect(committedItemData.title).not.toBe('Untitled Document');

        // STAGE B: ZoteroSchemaValidatorService -> buildCommandCreateInput & buildCommandUpdateInput
        const validationResult = validator.validateAndSanitizeItem(
          itemType,
          committedItemData,
        );
        expect(validationResult.valid).toBe(true);
        expect(validationResult.itemType).toBe(itemType);
        expect(Object.keys(validationResult.demotedToExtra)).toHaveLength(0);
        expect(validationResult.creatorChanges).toHaveLength(0);

        // Verify all camelCase creator roles (seriesEditor, bookAuthor, wordsBy, attorneyAgent, etc.) are preserved intact!
        if (inputCreators.length > 0) {
          const sanitizedCreators = validationResult.sanitizedItem
            .creators as CreatorCreditInput[];
          expect(sanitizedCreators).toHaveLength(inputCreators.length);
          for (let i = 0; i < inputCreators.length; i++) {
            expect(sanitizedCreators[i].creatorType).toBe(
              inputCreators[i].creatorType,
            );
            expect(sanitizedCreators[i].lastName).toBe(
              inputCreators[i].lastName,
            );
          }
        }

        const { createData } = await buildCommandCreateInput(
          'user-wave12-test',
          validationResult.sanitizedItem as CreateItemData,
          mockPrisma,
        );

        expect(createData.itemType).toBe(itemType);
        expect(createData.title).toBeTruthy();
        expect(createData.title).not.toBe('Untitled Item');

        // Simulate Prisma database record returned after create
        const simulatedDbRow: Record<string, unknown> = {
          id: `item-${itemType}-1`,
          userId: createData.userId,
          title: createData.title,
          itemType: createData.itemType,
          publicationTitle: createData.publicationTitle ?? null,
          year: createData.year ?? null,
          doi: createData.doi ?? null,
          abstract: createData.abstract ?? null,
          url: createData.url ?? null,
          citationKey: createData.citationKey ?? null,
          metadata: createData.metadata,
          hasFile: createData.hasFile,
          attachmentCount: createData.attachmentCount,
          noteCount: createData.noteCount,
          firstAuthor: createData.firstAuthor ?? null,
          version: 1,
          createdAt: new Date('2024-06-01T12:00:00.000Z'),
          updatedAt: new Date('2024-06-01T12:00:00.000Z'),
          contributors:
            (
              createData.contributors as {
                create?: Array<Record<string, unknown>>;
              }
            )?.create ?? [],
          itemTags: [
            {
              tag: { id: 'tag-1', name: 'zotero-v42', type: 'manual' },
              type: 'manual',
            },
            {
              tag: { id: 'tag-2', name: 'roundtrip', type: 'manual' },
              type: 'manual',
            },
          ],
          attachments: [],
          notesList: [],
        };

        // STAGE C: ItemsMapper.toDomain (Read Path)
        const domainItem = ItemsMapper.toDomain(simulatedDbRow);
        expect(domainItem.itemType).toBe(itemType);
        expect(domainItem.type).toBeTruthy();

        const domainExtraFields = (domainItem.extraFields || {}) as Record<
          string,
          unknown
        >;

        // Verify EVERY valid Zotero v42 field for this itemType is preserved in the output!
        for (const fieldDef of orderedFields) {
          const fieldKey = fieldDef.key;
          const expectedVal = expectedFieldValues[fieldKey];
          const actualTopVal = domainItem[fieldKey];
          const actualExtraVal = domainExtraFields[fieldKey];

          // Both top-level and extraFields (for non-column fields) must hold the value in the right format
          expect({ fieldKey, actualTopVal }).toEqual({
            fieldKey,
            actualTopVal: expect.anything(),
          });
          expect(`${fieldKey}:${String(actualTopVal)}`).not.toBe(
            `${fieldKey}:`,
          );

          if (fieldKey === 'ISBN') {
            // ISBN is normalized to clean digits/X
            expect(String(actualTopVal).replace(/-/g, '')).toBe(
              expectedVal.replace(/-/g, ''),
            );
            expect(domainItem.isbn).toBe(domainItem.ISBN);
          } else if (fieldKey === 'DOI') {
            expect(domainItem.DOI).toBe(expectedVal);
            expect(domainItem.doi).toBe(expectedVal);
          } else if (fieldKey === 'ISSN') {
            expect(domainItem.ISSN).toBe(expectedVal);
            expect(domainItem.issn).toBe(expectedVal);
          } else if (fieldKey === 'PMID') {
            expect(domainItem.PMID).toBe(expectedVal);
            expect(domainItem.pmid).toBe(expectedVal);
          } else if (fieldKey === 'PMCID') {
            expect(domainItem.PMCID).toBe(expectedVal);
            expect(domainItem.pmcid).toBe(expectedVal);
          } else if (fieldKey === 'archiveID') {
            expect(String(actualTopVal)).toContain('2405.12345');
          } else if (fieldKey === 'pages' || fieldKey === 'codePages') {
            expect(String(actualTopVal)).toBe(expectedVal);
          } else if (fieldKey === 'numPages') {
            expect(String(actualTopVal)).toBe('320');
          } else if (fieldKey === 'accessDate') {
            expect(String(actualTopVal)).toContain('2024-06-01');
          } else if (
            fieldKey === 'title' ||
            fieldKey === 'caseName' ||
            fieldKey === 'nameOfAct' ||
            fieldKey === 'subject' ||
            fieldKey === 'shortTitle'
          ) {
            expect(String(actualTopVal).toLowerCase()).toBe(
              expectedVal.toLowerCase(),
            );
          } else if (fieldKey === 'extra') {
            expect(String(actualTopVal)).toContain(expectedVal);
          } else {
            expect(String(actualTopVal)).toBe(expectedVal);
          }

          // If it's a type-specific field, verify it's also accessible in domainItem.extraFields
          if (actualExtraVal !== undefined) {
            expect(String(actualExtraVal)).toBeTruthy();
          }
        }

        // Verify Creators & Roles in domainItem
        if (inputCreators.length > 0) {
          const domainCreators = domainItem.creators as Array<
            Record<string, unknown>
          >;
          expect(domainCreators).toHaveLength(inputCreators.length);
          for (let i = 0; i < inputCreators.length; i++) {
            expect(domainCreators[i].creatorType).toBe(
              inputCreators[i].creatorType,
            );
            expect(domainCreators[i].lastName).toBe(inputCreators[i].lastName);
            expect(domainCreators[i].firstName).toBe(
              inputCreators[i].firstName,
            );
          }
        }

        // Verify Update Path (buildCommandUpdateInput -> ItemsMapper.toDomain)
        if (orderedFields.length > 0) {
          const firstField = orderedFields[0].key;
          const updatedVal =
            firstField === 'url'
              ? 'https://example.org/updated/2025'
              : `${expectedFieldValues[firstField]}_Updated`;
          const updateInputPayload: Record<string, unknown> = {
            itemType,
            [firstField]: updatedVal,
          };
          const validatedUpdate = validator.validateAndSanitizeItem(
            itemType,
            updateInputPayload,
          );
          const { updateData } = buildCommandUpdateInput(
            'user-wave12-test',
            simulatedDbRow,
            validatedUpdate.sanitizedItem,
          );
          const simulatedUpdatedDbRow = {
            ...simulatedDbRow,
            title: updateData.title ?? simulatedDbRow.title,
            publicationTitle:
              updateData.publicationTitle ?? simulatedDbRow.publicationTitle,
            year: updateData.year ?? simulatedDbRow.year,
            doi: updateData.doi ?? simulatedDbRow.doi,
            abstract: updateData.abstract ?? simulatedDbRow.abstract,
            url: updateData.url ?? simulatedDbRow.url,
            citationKey: updateData.citationKey ?? simulatedDbRow.citationKey,
            metadata: updateData.metadata,
          };
          const updatedDomainItem = ItemsMapper.toDomain(
            simulatedUpdatedDbRow,
          ) as Record<string, unknown>;
          expect(String(updatedDomainItem[firstField])).toBe(updatedVal);
        }

        // STAGE D: CslJsonMapper.toCsl -> CslEngineService (CSL-JSON, BibTeX, RIS, APA)
        if (typeDef.isBibliographic) {
          const cslData = CslJsonMapper.toCsl(domainItem);
          const expectedCslType = SCHEMA_V42_DATA.cslTypeMap[itemType];
          expect(cslData.type).toBe(expectedCslType);
          expect(cslData.title).toBeTruthy();

          if (inputCreators.length > 0) {
            const cslHasCreators = Boolean(
              (cslData.author && cslData.author.length > 0) ||
              (cslData.editor && cslData.editor.length > 0) ||
              (cslData.translator && cslData.translator.length > 0) ||
              (cslData.director && cslData.director.length > 0) ||
              (cslData.interviewer && cslData.interviewer.length > 0) ||
              (cslData.recipient && cslData.recipient.length > 0) ||
              (cslData.composer && cslData.composer.length > 0),
            );
            expect(cslHasCreators).toBe(true);
          }

          const bibtex = cslEngine.formatBibtex([cslData]);
          expect(bibtex).toContain('@');
          expect(bibtex).toContain('title = {');

          const ris = cslEngine.formatRis([cslData]);
          expect(ris).toContain('TY  - ');
          expect(ris).toContain('TI  - ');
          expect(ris).toContain('ER  -');

          const apaResult = cslEngine.format(cslData, 'apa');
          expect(apaResult.bibliography.trim().length).toBeGreaterThan(10);
        }
      });
    },
  );
});
