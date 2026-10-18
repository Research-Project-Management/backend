import {
  ALL_CREATOR_ROLES,
  ALL_RECONCILABLE_METADATA_FIELDS,
  BASE_FIELD_MAPPINGS,
  harmonizeZoteroFields,
  resolveBidirectionalBaseFields,
  resolveCanonicalCreatorRole,
  resolveFieldAliases,
  SCHEMA_V42_DATA,
} from '@/modules/library/core';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import { MetadataReconciliationService } from '@/modules/library/ingestion/services/metadata-reconciliation.service';
import { toItemData } from '@/modules/library/ingestion/stages/commit.stage';
import {
  buildCommandCreateInput,
  buildCommandUpdateInput,
  prepareContributorsToCreate,
  resolveCanonicalCommandFields,
} from '@/modules/library/catalog/domain/command-payload.builder';
import { ItemsMapper } from '@/modules/library/catalog/domain/items.mapper';
import { fromPartial } from '@total-typescript/shoehorn';
import { MetadataCandidate } from '@/modules/library/ingestion/types/metadata.types';

describe('Wave 13: Standardized Pipeline Architecture & Single-Source-of-Truth Harmonizer', () => {
  const normalizationPolicy = new NormalizationPolicy();
  const reconciliationService = new MetadataReconciliationService();

  const mockPrismaClient = {
    tag: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
  } as unknown as Parameters<typeof buildCommandCreateInput>[2];

  describe('1. Single-Source-of-Truth Zotero Field Harmonizer (Idempotency & Bidirectional Base Mapping)', () => {
    it('is strictly idempotent across all 37 Zotero v42 item types', () => {
      const itemTypeKeys = Object.keys(SCHEMA_V42_DATA.itemTypes);
      expect(itemTypeKeys.length).toBeGreaterThanOrEqual(37);

      for (const itemType of itemTypeKeys) {
        const baseMap = BASE_FIELD_MAPPINGS[itemType] || {};
        const seedPayload: Record<string, unknown> = {
          itemType,
          title: `Canonical Title for ${itemType}`,
          publicationTitle: `Canonical Venue for ${itemType}`,
          publisher: `Canonical Publisher for ${itemType}`,
          date: '2025-05-15',
          volume: '42',
          issue: '7',
          pages: '100-125',
          place: 'Cambridge, MA',
          DOI: '10.1000/wave13.test',
          ISBN: '978-0-262-03384-8',
          ISSN: '1234-5678',
          archiveID: 'arXiv:2505.12345',
          abstractNote: 'Abstract content for idempotency verification.',
          journalAbbreviation: 'J. Wave Test',
          rights: 'CC-BY-4.0',
          extraFields: {},
        };

        // Also test reverse direction where only mapped fields are provided
        const reverseSeedPayload: Record<string, unknown> = {
          itemType,
          extraFields: {},
        };
        for (const [baseField, mappedField] of Object.entries(baseMap)) {
          reverseSeedPayload[mappedField] =
            `Mapped ${mappedField} (${baseField}) for ${itemType}`;
        }

        const onceForward = harmonizeZoteroFields(seedPayload, {
          itemType,
          syncExtraFields: true,
        });
        const twiceForward = harmonizeZoteroFields(onceForward, {
          itemType,
          syncExtraFields: true,
        });
        expect(twiceForward).toEqual(onceForward);

        const onceReverse = harmonizeZoteroFields(reverseSeedPayload, {
          itemType,
          syncExtraFields: true,
        });
        const twiceReverse = harmonizeZoteroFields(onceReverse, {
          itemType,
          syncExtraFields: true,
        });
        expect(twiceReverse).toEqual(onceReverse);

        // Verify bidirectional base field population
        for (const [baseField, mappedField] of Object.entries(baseMap)) {
          if (baseField === 'type' || baseField === 'medium') continue;
          if (seedPayload[baseField] !== undefined) {
            expect(onceForward[mappedField]).toBe(seedPayload[baseField]);
          }
          expect(onceReverse[baseField]).toBe(reverseSeedPayload[mappedField]);
        }
      }
    });

    it('synchronizes all FIELD_ALIASES and multi-way canonical alias groups without data loss', () => {
      const record: Record<string, unknown> = {
        DOI: '10.1038/s41586-025-00001-1',
        ISBN: '978-3-16-148410-0',
        ISSN: '0028-0836',
        PMID: '39123456',
        PMCID: 'PMC11223344',
        archiveID: '2501.99999',
        journalAbbreviation: 'Nat.',
        abstractNote:
          'Quantum error correction below the surface code threshold.',
        citeKey: 'google2025quantum',
        URL: 'https://www.nature.com/articles/s41586-025-00001-1',
        license: 'CC-BY-4.0',
        numberOfPages: 18,
        issuingAuthority: 'United States Patent and Trademark Office',
      };

      resolveFieldAliases(record);

      expect(record.doi).toBe('10.1038/s41586-025-00001-1');
      expect(record.isbn).toBe('978-3-16-148410-0');
      expect(record.issn).toBe('0028-0836');
      expect(record.pmid).toBe('39123456');
      expect(record.pmcid).toBe('PMC11223344');
      expect(record.arxivId).toBe('2501.99999');
      expect(record.archiveId).toBe('2501.99999');
      expect(record.journalAbbr).toBe('Nat.');
      expect(record.abstract).toBe(
        'Quantum error correction below the surface code threshold.',
      );
      expect(record.citationKey).toBe('google2025quantum');
      expect(record.url).toBe(
        'https://www.nature.com/articles/s41586-025-00001-1',
      );
      expect(record.rights).toBe('CC-BY-4.0');
      expect(record.numPages).toBe(18);
      expect(record.authority).toBe(
        'United States Patent and Trademark Office',
      );
    });
  });

  describe('2. Canonical Creator Role Resolution across all 37 Zotero v42 Roles', () => {
    it('preserves and normalizes all 37 Zotero v42 creator roles (case-insensitive & snake_case)', () => {
      const allRoles = Object.keys(ALL_CREATOR_ROLES);
      expect(allRoles.length).toBe(37);

      for (const canonicalRole of allRoles) {
        // Exact match
        expect(resolveCanonicalCreatorRole(canonicalRole)).toBe(canonicalRole);
        // Lowercase match (e.g., bookauthor -> bookAuthor)
        expect(resolveCanonicalCreatorRole(canonicalRole.toLowerCase())).toBe(
          canonicalRole,
        );
        // Uppercase match (e.g., SERIESEDITOR -> seriesEditor)
        expect(resolveCanonicalCreatorRole(canonicalRole.toUpperCase())).toBe(
          canonicalRole,
        );
        // snake_case match (e.g., cast_member -> castMember, words_by -> wordsBy, attorney_agent -> attorneyAgent)
        const snakeCase = canonicalRole
          .replace(/([A-Z])/g, '_$1')
          .toLowerCase();
        expect(resolveCanonicalCreatorRole(snakeCase)).toBe(canonicalRole);
      }

      // Academic role synonyms
      expect(resolveCanonicalCreatorRole('primary_author')).toBe('author');
      expect(resolveCanonicalCreatorRole('corresponding_author')).toBe(
        'author',
      );
      expect(
        resolveCanonicalCreatorRole('advisor', { itemType: 'thesis' }),
      ).toBe('contributor');
    });

    it('harmonizes creator roles consistently across NormalizationPolicy, CommitStage, CommandPayloadBuilder, and ItemsMapper', () => {
      const rawCreators = [
        { firstName: 'Ada', lastName: 'Lovelace', creatorType: 'book_author' },
        {
          firstName: 'Charles',
          lastName: 'Babbage',
          creatorType: 'serieseditor',
        },
      ];

      const normalized = normalizationPolicy.normalize({
        itemType: 'bookSection',
        title: 'Notes on the Analytical Engine',
        creators: rawCreators,
      });
      expect(normalized.creators?.[0]?.creatorType).toBe('bookAuthor');
      expect(normalized.creators?.[1]?.creatorType).toBe('seriesEditor');

      const itemData = toItemData(normalized);
      expect(itemData.creators?.[0]?.creatorType).toBe('bookAuthor');
      expect(itemData.creators?.[1]?.creatorType).toBe('seriesEditor');

      const contributors = prepareContributorsToCreate(
        { creators: rawCreators },
        'bookSection',
      );
      expect(contributors?.[0]?.creatorType).toBe('bookAuthor');
      expect(contributors?.[1]?.creatorType).toBe('seriesEditor');

      const domainItem: any = ItemsMapper.toDomain({
        id: 'item-1',
        itemType: 'bookSection',
        title: 'Notes on the Analytical Engine',
        contributors: rawCreators,
      });
      expect(domainItem.creators?.[0]?.creatorType).toBe('bookAuthor');
      expect(domainItem.creators?.[1]?.creatorType).toBe('seriesEditor');
    });
  });

  describe('3. Create & Update Command Payload Builder Parity', () => {
    const representativeTypePayloads: Array<{
      itemType: string;
      payload: Record<string, unknown>;
      expectedTitle: string;
      expectedPubTitle: string;
      expectedPublisher: string;
      expectedDate: string;
      expectedVolume: string;
      expectedIssue: string;
      expectedPages: string;
      expectedPlace: string;
    }> = [
      {
        itemType: 'case',
        payload: {
          caseName: 'Obergefell v. Hodges',
          court: 'Supreme Court of the United States',
          dateDecided: '2015-06-26',
          reporter: 'U.S.',
          reporterVolume: '576',
          docketNumber: '14-556',
          firstPage: '644',
          place: 'Washington, D.C.',
        },
        expectedTitle: 'Obergefell v. Hodges',
        expectedPubTitle: 'U.S.',
        expectedPublisher: '',
        expectedDate: '2015-06-26',
        expectedVolume: '576',
        expectedIssue: '14-556',
        expectedPages: '644',
        expectedPlace: 'Washington, D.C.',
      },
      {
        itemType: 'statute',
        payload: {
          nameOfAct: 'Americans with Disabilities Act of 1990',
          code: 'U.S.C.',
          codeNumber: '42',
          publicLawNumber: '101-336',
          dateEnacted: '1990-07-26',
          pages: '327-388',
        },
        expectedTitle: 'Americans with Disabilities Act of 1990',
        expectedPubTitle: 'U.S.C.',
        expectedPublisher: '',
        expectedDate: '1990-07-26',
        expectedVolume: '42',
        expectedIssue: '101-336',
        expectedPages: '327-388',
        expectedPlace: '',
      },
      {
        itemType: 'patent',
        payload: {
          title: 'Method and System for Neural Attention',
          issuingAuthority: 'USPTO',
          patentNumber: 'US-11223344-B2',
          issueDate: '2024-03-19',
          country: 'United States',
          pages: '1-42',
        },
        expectedTitle: 'Method and System for Neural Attention',
        expectedPubTitle: '',
        expectedPublisher: '',
        expectedDate: '2024-03-19',
        expectedVolume: '',
        expectedIssue: 'US-11223344-B2',
        expectedPages: '1-42',
        expectedPlace: 'United States',
      },
      {
        itemType: 'thesis',
        payload: {
          title: 'Type Systems for Distributed Actor Runtimes',
          university: 'ETH Zurich',
          thesisType: 'PhD Dissertation',
          date: '2024-11-01',
          place: 'Zurich, Switzerland',
        },
        expectedTitle: 'Type Systems for Distributed Actor Runtimes',
        expectedPubTitle: '',
        expectedPublisher: 'ETH Zurich',
        expectedDate: '2024-11-01',
        expectedVolume: '',
        expectedIssue: '',
        expectedPages: '',
        expectedPlace: 'Zurich, Switzerland',
      },
      {
        itemType: 'report',
        payload: {
          title: 'Global Climate Risk Assessment 2025',
          institution: 'World Meteorological Organization',
          reportNumber: 'WMO-No. 1350',
          reportType: 'Technical Report',
          seriesTitle: 'WMO Climate Reports',
          date: '2025-02-10',
          place: 'Geneva',
          pages: '1-88',
        },
        expectedTitle: 'Global Climate Risk Assessment 2025',
        expectedPubTitle: '',
        expectedPublisher: 'World Meteorological Organization',
        expectedDate: '2025-02-10',
        expectedVolume: '',
        expectedIssue: 'WMO-No. 1350',
        expectedPages: '1-88',
        expectedPlace: 'Geneva',
      },
      {
        itemType: 'conferencePaper',
        payload: {
          title:
            'FlashAttention-3: Fast and Accurate Attention with Asynchrony',
          proceedingsTitle:
            'Advances in Neural Information Processing Systems (NeurIPS)',
          publisher: 'Curran Associates, Inc.',
          date: '2024-12-10',
          volume: '37',
          pages: '1500-1515',
          eventPlace: 'Vancouver, Canada',
        },
        expectedTitle:
          'FlashAttention-3: Fast and Accurate Attention with Asynchrony',
        expectedPubTitle:
          'Advances in Neural Information Processing Systems (NeurIPS)',
        expectedPublisher: 'Curran Associates, Inc.',
        expectedDate: '2024-12-10',
        expectedVolume: '37',
        expectedIssue: '',
        expectedPages: '1500-1515',
        expectedPlace: 'Vancouver, Canada',
      },
    ];

    it.each(representativeTypePayloads)(
      'produces identical canonical metadata resolution between buildCommandCreateInput and buildCommandUpdateInput for $itemType',
      async ({
        itemType,
        payload,
        expectedTitle,
        expectedPubTitle,
        expectedPublisher,
        expectedDate,
        expectedVolume,
        expectedIssue,
        expectedPages,
        expectedPlace,
      }) => {
        const inputData = {
          itemType,
          ...payload,
        };

        const { createData } = await buildCommandCreateInput(
          'user-123',
          inputData as Parameters<typeof buildCommandCreateInput>[1],
          mockPrismaClient,
        );

        const existingBlankItem = {
          id: 'item-existing-1',
          userId: 'user-123',
          title: 'Old Placeholder Title',
          itemType,
          year: null,
          doi: '',
          abstract: '',
          url: '',
          citationKey: '',
          extra: '',
          metadata: {},
        };

        const { updateData } = buildCommandUpdateInput(
          'user-123',
          existingBlankItem,
          inputData,
        );

        expect(createData.title).toBe(expectedTitle);
        expect(updateData.title).toBe(expectedTitle);

        const createMeta = createData.metadata as Record<string, unknown>;
        const updateMeta = updateData.metadata as Record<string, unknown>;

        expect(createMeta.publicationTitle).toBe(expectedPubTitle);
        if (expectedPubTitle) {
          expect(updateMeta.publicationTitle).toBe(expectedPubTitle);
        }

        expect(createMeta.publisher).toBe(expectedPublisher);
        if (expectedPublisher) {
          expect(updateMeta.publisher).toBe(expectedPublisher);
        }

        expect(createMeta.date).toBe(expectedDate);
        if (expectedDate) {
          expect(updateMeta.date).toBe(expectedDate);
        }

        expect(createMeta.volume).toBe(expectedVolume);
        if (expectedVolume) {
          expect(updateMeta.volume).toBe(expectedVolume);
        }

        expect(createMeta.issue).toBe(expectedIssue);
        if (expectedIssue) {
          expect(updateMeta.issue).toBe(expectedIssue);
        }

        expect(createMeta.pages).toBe(expectedPages);
        if (expectedPages) {
          expect(updateMeta.pages).toBe(expectedPages);
        }

        expect(createMeta.place).toBe(expectedPlace);
        if (expectedPlace) {
          expect(updateMeta.place).toBe(expectedPlace);
        }

        // Verify roundtrip through ItemsMapper.toDomain produces identical domain projection
        const domainFromCreate: any = ItemsMapper.toDomain({
          id: 'item-new',
          ...createData,
        });
        const domainFromUpdate: any = ItemsMapper.toDomain({
          ...existingBlankItem,
          ...updateData,
        });

        expect(domainFromUpdate.title).toBe(domainFromCreate.title);
        expect(domainFromUpdate.publicationTitle).toBe(
          domainFromCreate.publicationTitle,
        );
        expect(domainFromUpdate.publisher).toBe(domainFromCreate.publisher);
        expect(domainFromUpdate.date).toBe(domainFromCreate.date);
        expect(domainFromUpdate.volume).toBe(domainFromCreate.volume);
        expect(domainFromUpdate.issue).toBe(domainFromCreate.issue);
        expect(domainFromUpdate.pages).toBe(domainFromCreate.pages);
        expect(domainFromUpdate.place).toBe(domainFromCreate.place);
      },
    );
  });

  describe('4. Standardized Ingestion -> Reconciliation -> Commit -> Domain Handoff', () => {
    it('reconciles all schema-driven Zotero v42 fields without dropping legal, media, or software fields', () => {
      expect(ALL_RECONCILABLE_METADATA_FIELDS).toContain('caseName');
      expect(ALL_RECONCILABLE_METADATA_FIELDS).toContain('court');
      expect(ALL_RECONCILABLE_METADATA_FIELDS).toContain('dateDecided');
      expect(ALL_RECONCILABLE_METADATA_FIELDS).toContain('reporterVolume');
      expect(ALL_RECONCILABLE_METADATA_FIELDS).toContain('firstPage');
      expect(ALL_RECONCILABLE_METADATA_FIELDS).toContain('docketNumber');
      expect(ALL_RECONCILABLE_METADATA_FIELDS).toContain('nameOfAct');
      expect(ALL_RECONCILABLE_METADATA_FIELDS).toContain('publicLawNumber');
      expect(ALL_RECONCILABLE_METADATA_FIELDS).toContain('dateEnacted');
      expect(ALL_RECONCILABLE_METADATA_FIELDS).toContain('programmingLanguage');
      expect(ALL_RECONCILABLE_METADATA_FIELDS).toContain(
        'audioRecordingFormat',
      );
      expect(ALL_RECONCILABLE_METADATA_FIELDS).toContain('artworkMedium');

      // Reconcile a legal case where only Zotero type-specific fields are provided
      const reconciledCase = reconciliationService.reconcile([
        fromPartial<MetadataCandidate>({
          sourceProvider: 'ZoteroSync',
          confidenceScore: 0.95,
          metadata: {
            itemType: 'case',
            caseName: 'Marbury v. Madison',
            court: 'Supreme Court of the United States',
            dateDecided: '1803-02-24',
            reporter: 'Cranch',
            reporterVolume: '5',
            firstPage: '137',
            docketNumber: '1803-SCOTUS-1',
            creators: [
              {
                firstName: 'John',
                lastName: 'Marshall',
                creatorType: 'author',
              },
              {
                firstName: 'Charles',
                lastName: 'Lee',
                creatorType: 'counsel',
              },
            ],
          },
        }),
      ]);

      // Must NOT fall back to 'Untitled Document' when caseName is present
      expect(reconciledCase.metadata.title).toBe('Marbury v. Madison');
      expect(
        (reconciledCase.metadata as Record<string, unknown>).caseName,
      ).toBe('Marbury v. Madison');
      expect((reconciledCase.metadata as Record<string, unknown>).court).toBe(
        'Supreme Court of the United States',
      );
      expect(reconciledCase.metadata.publicationTitle).toBe('Cranch');
      expect(reconciledCase.metadata.volume).toBe('5');
      expect(reconciledCase.metadata.pages).toBe('137');
      expect(reconciledCase.metadata.issue).toBe('1803-SCOTUS-1');

      // Handoff to CommitStage.toItemData
      const commitPayload = toItemData(reconciledCase.metadata, {
        userId: 'user-1',
      });
      expect(commitPayload.title).toBe('Marbury v. Madison');
      expect(commitPayload.publicationTitle).toBe('Cranch');
      expect(commitPayload.volume).toBe('5');
      expect(commitPayload.pages).toBe('137');
      expect(commitPayload.issue).toBe('1803-SCOTUS-1');
      expect(commitPayload.extraFields?.caseName).toBe('Marbury v. Madison');
      expect(commitPayload.extraFields?.court).toBe(
        'Supreme Court of the United States',
      );
      expect(commitPayload.creators?.[1]?.creatorType).toBe('counsel');
    });

    it('maintains end-to-end fidelity for reverse base field mappings (base -> mapped) on thesis and conferencePaper', () => {
      // Suppose an external provider (e.g. Crossref) returns `publisher` and `publicationTitle`
      // for a thesis or conferencePaper without setting `university` or `proceedingsTitle`
      const normalizedThesis = normalizationPolicy.normalize({
        itemType: 'thesis',
        title: 'Formal Verification of Consensus Protocols',
        publisher: 'Stanford University',
        publicationDate: '2024-06-01',
      });
      expect((normalizedThesis as Record<string, unknown>).university).toBe(
        'Stanford University',
      );

      const resolvedFields = resolveCanonicalCommandFields(
        {
          itemType: 'thesis',
          title: 'Formal Verification of Consensus Protocols',
          publisher: 'Stanford University',
        },
        'thesis',
      );
      expect(resolvedFields.rawPublisher).toBe('Stanford University');
      expect(resolvedFields.effectiveExtraFields.university).toBe(
        'Stanford University',
      );
    });
  });
});
