import {
  normalizeIsbn,
  normalizeIssn,
  cleanSingleTag,
  normalizeAcademicTags,
  isNoiseAuthorName,
  cleanAuthorName,
  parseCreatorString,
  mergeCanonicalCreators,
} from '@/modules/library/core';
import {
  cleanSingleIdentifier,
  normalizeItemIdentifiers,
  calculateIdentifierChanges,
  resolveCanonicalCommandFields,
  buildMetadataPartial,
  buildCommandUpdateInput,
} from '@/modules/library/catalog/domain/command-payload.builder';
import { ZoteroSchemaValidatorService } from '@/modules/library/catalog/services/zotero-schema-validator.service';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import { ConditionEvaluatorEngine } from '@/modules/library/catalog/domain/condition-evaluator.engine';
import { extractIdentifiersFromText } from '@/modules/library/ingestion/parsers/ris-fallback.parser';
import { CslParser } from '@/modules/library/ingestion/parsers/csl.parser';
import { DomainRateLimiterService } from '@/modules/library/ingestion/services/domain-rate-limiter.service';
import { WebFetchLadderService } from '@/modules/library/ingestion/services/web-fetch-ladder.service';
import { IngestionVerifierService } from '@/modules/library/ingestion/services/ingestion-verifier.service';
import { SsrfGuardService } from '@/modules/library/core/services/ssrf-guard.service';
import { MetadataRoutingPolicy } from '@/modules/library/ingestion/policies/metadata.policy';

describe('Gatekeeper Validation, Sanitization & Parser Guards Security Audit (GE2)', () => {
  describe('Fix 1: ISBN & ISSN Multi-Token / Qualifier Normalization (identifier.domain.ts)', () => {
    it('extracts valid ISBNs from qualifier-annotated and semicolon-delimited strings', () => {
      expect(
        normalizeIsbn(
          '978-0-306-40615-7 (hardcover); 978-0-306-40616-4 (ebook)',
        ),
      ).toBe('9780306406157');
      expect(normalizeIsbn('ISBN-13: 978-0-262-03384-8 (alk. paper)')).toBe(
        '9780262033848',
      );
      expect(normalizeIsbn('0-306-40615-2 (pbk.)')).toBe('0306406152');
      expect(normalizeIsbn('0-306-40615-2 (pbk.)', { toIsbn13: true })).toBe(
        '9780306406157',
      );
    });

    it('skips checksum-invalid candidate when strictChecksum is enabled and returns next valid ISBN', () => {
      expect(
        normalizeIsbn('978-0-306-40615-8 (print); 978-0-306-40615-7 (online)', {
          strictChecksum: true,
        }),
      ).toBe('9780306406157');
    });

    it('rejects DOIs, URLs, ISSNs, and newline-split numbers in normalizeIsbn', () => {
      expect(normalizeIsbn('https://doi.org/10.1000/9780306406157')).toBeUndefined();
      expect(normalizeIsbn('10.1000/9780306406157')).toBeUndefined();
      expect(normalizeIsbn('ISSN: 0378-5955')).toBeUndefined();
      expect(normalizeIsbn('0-306-406\n2023')).toBeUndefined();
    });

    it('extracts valid ISSNs with print/online/linking qualifiers and e-ISSN prefixes', () => {
      expect(normalizeIssn('0378-5955 (Print); 1558-2558 (Online)')).toBe(
        '0378-5955',
      );
      expect(normalizeIssn('e-ISSN: 2041-1723 (electronic)')).toBe('2041-1723');
      expect(normalizeIssn('ISSN 2434-561X (Linking)')).toBe('2434-561X');
    });

    it('rejects ISBNs, DOIs, and URLs in normalizeIssn', () => {
      expect(normalizeIssn('978-0-306-40615-7')).toBeUndefined();
      expect(normalizeIssn('10.1038/0378-5955')).toBeUndefined();
      expect(normalizeIssn('https://example.org/0378-5955')).toBeUndefined();
    });
  });

  describe('Fix 2: Identifier Fallbacks vs Explicit Clearing & Typo Preservation', () => {
    it('falls back to non-stale extraFields or explicit identifiers when top-level field is empty string', () => {
      const resolvedFromEf = normalizeItemIdentifiers({
        doi: '',
        extraFields: { doi: '10.1038/nature12373' },
      });
      expect(resolvedFromEf.doi).toBe('10.1038/nature12373');

      const resolvedFromIdentList = normalizeItemIdentifiers({
        isbn: '',
        identifiers: [{ type: 'isbn', value: '978-0-262-03384-8' }],
      });
      expect(resolvedFromIdentList.isbn).toBe('9780262033848');
    });

    it('clears identifier when top-level is empty string or null and extraFields only echoes stale extra', () => {
      const cleared = normalizeItemIdentifiers({
        doi: '',
        isbn: null,
        extraFields: { doi: '10.1000/stale', isbn: '978-0-262-03384-8' },
        extra: 'DOI: 10.1000/stale\nISBN: 978-0-262-03384-8\nCustom: Value',
      });
      expect(cleared.doi).toBe('');
      expect(cleared.isbn).toBe('');
    });

    it('preserves existing valid identifiers on update when given an accidental typo, while allowing explicit clear', () => {
      expect(cleanSingleIdentifier('not-a-valid-doi', (v) => (v === '10.1/a' ? v : undefined))).toBe('');
      expect(
        cleanSingleIdentifier(
          'not-a-valid-doi',
          (v) => (v === '10.1/a' ? v : undefined),
          { preserveOnInvalid: true },
        ),
      ).toBeUndefined();
      expect(
        cleanSingleIdentifier('', (v) => v ?? undefined, {
          preserveOnInvalid: true,
        }),
      ).toBe('');

      const existingItem = {
        id: 'item-1',
        userId: 'user-1',
        title: 'Existing Paper',
        itemType: 'journalArticle',
        doi: '10.1038/nature12373',
        metadata: {
          doi: '10.1038/nature12373',
          isbn: '9780262033848',
        },
        identifiers: [
          {
            type: 'doi',
            value: '10.1038/nature12373',
            canonicalUri: 'https://doi.org/10.1038/nature12373',
          },
          {
            type: 'isbn',
            value: '9780262033848',
            canonicalUri: 'urn:isbn:9780262033848',
          },
        ],
      };

      // 1) Accidental invalid DOI typo on update -> does NOT wipe existing DOI
      const typoUpdate = buildCommandUpdateInput('user-1', existingItem, {
        doi: '10.1038-typo-no-slash',
      });
      expect(typoUpdate.cleanIds.doi).toBeUndefined();
      expect(typoUpdate.updateData.doi).toBe('10.1038/nature12373');
      const typoMeta = typoUpdate.updateData.metadata as Record<string, unknown>;
      expect(typoMeta.doi).toBe('10.1038/nature12373');
      expect(calculateIdentifierChanges(typoUpdate.cleanIds, existingItem)).toEqual([]);

      // 2) Explicit clear via empty string -> clears column, metadata, and emits deletion change
      const explicitClear = buildCommandUpdateInput('user-1', existingItem, {
        doi: '',
      });
      expect(explicitClear.cleanIds.doi).toBe('');
      expect(explicitClear.updateData.doi).toBeNull();
      const clearMeta = explicitClear.updateData.metadata as Record<string, unknown>;
      expect(clearMeta.doi).toBeNull();
      expect(calculateIdentifierChanges(explicitClear.cleanIds, existingItem)).toEqual([
        { type: 'doi', value: '', canonicalUri: '' },
      ]);

      // 3) Explicit clear via null (e.g., Page-1 Citation Trap rollback) -> clears column, metadata, and emits deletion change even if extra has stale echo
      const nullClearWithStaleExtra = buildCommandUpdateInput(
        'user-1',
        { ...existingItem, extra: 'DOI: 10.1038/nature12373' },
        {
          doi: null,
          extraFields: { doi: null, DOI: '10.1038/nature12373' },
        },
      );
      expect(nullClearWithStaleExtra.cleanIds.doi).toBe('');
      expect(nullClearWithStaleExtra.updateData.doi).toBeNull();
      expect(
        calculateIdentifierChanges(
          { doi: null },
          existingItem,
        ),
      ).toEqual([{ type: 'doi', value: '', canonicalUri: '' }]);
    });
  });

  describe('Fix 3: Non-Column Zotero Alias Harmonization (command-payload.builder.ts)', () => {
    it('preserves and synchronizes numPages <-> numberOfPages and authority <-> issuingAuthority', () => {
      const bookCanonical = resolveCanonicalCommandFields(
        {
          title: 'Deep Learning',
          itemType: 'book',
          extraFields: { numberOfPages: 800 },
        },
        'book',
        null,
      );
      expect(bookCanonical.effectiveExtraFields.numPages).toBe(800);
      expect(bookCanonical.effectiveExtraFields.numberOfPages).toBe(800);

      const patentCanonical = resolveCanonicalCommandFields(
        {
          title: 'Neural Processor',
          itemType: 'patent',
          issuingAuthority: 'USPTO',
          extra: 'original-date: 2018-05-01\nstatus: Granted',
        } as Record<string, unknown> as { title: string; itemType: string },
        'patent',
        null,
      );
      expect(patentCanonical.effectiveExtraFields.authority).toBe('USPTO');
      expect(patentCanonical.effectiveExtraFields.issuingAuthority).toBe('USPTO');
      expect(patentCanonical.effectiveExtraFields.originalDate).toBe('2018-05-01');
      expect(patentCanonical.effectiveExtraFields.status).toBe('Granted');
    });
  });

  describe('Fix 4: Provenance Unlocking, Zero Counts, Internal Key Stripping & UUID Guard', () => {
    it('4a: allows unlocking fields via explicit lockedFields array and cleans UserOverride provenance', () => {
      const existingItem = {
        id: 'item-lock-1',
        userId: 'user-1',
        title: 'Locked Title',
        itemType: 'journalArticle',
        abstract: 'Locked Abstract',
        metadata: {
          lockedFields: ['title', 'abstract'],
          fieldProvenance: {
            title: { source: 'UserOverride', isUserOverride: true },
            abstract: { source: 'UserOverride', isUserOverride: true },
          },
        },
      };

      const unlockedSingle = buildCommandUpdateInput('user-1', existingItem, {
        lockedFields: ['title'],
      } as Record<string, unknown>);
      const meta1 = unlockedSingle.updateData.metadata as Record<string, unknown>;
      expect(meta1.lockedFields).toEqual(['title']);
      const prov1 = meta1.fieldProvenance as Record<string, unknown>;
      expect(prov1.title).toBeDefined();
      expect(prov1.abstract).toBeUndefined();

      const unlockedAll = buildCommandUpdateInput('user-1', existingItem, {
        lockedFields: [],
      } as Record<string, unknown>);
      const meta2 = unlockedAll.updateData.metadata as Record<string, unknown>;
      expect(meta2.lockedFields).toEqual([]);
      const prov2 = meta2.fieldProvenance as Record<string, unknown> | undefined;
      expect(prov2?.title).toBeUndefined();
      expect(prov2?.abstract).toBeUndefined();
    });

    it('4b: preserves citationCount: 0 and referenceCount: 0 instead of coercing to null', () => {
      const data = {
        title: 'Brand New Preprint',
        itemType: 'preprint',
        citationCount: 0,
        referenceCount: 0,
      };
      const canonical = resolveCanonicalCommandFields(data, 'preprint', null);
      const ids = normalizeItemIdentifiers(data as never);
      const createdMeta = buildMetadataPartial({
        mode: 'create',
        baseMeta: {},
        data,
        canonical,
        ids,
      });
      expect(createdMeta.citationCount).toBe(0);
      expect(createdMeta.referenceCount).toBe(0);

      const updatedMeta = buildMetadataPartial({
        mode: 'update',
        baseMeta: { citationCount: 5, referenceCount: 12 },
        data,
        canonical,
        ids,
      });
      expect(updatedMeta.citationCount).toBe(0);
      expect(updatedMeta.referenceCount).toBe(0);
    });

    it('4c: strips __isSystemUpdate and __updateSource in ZoteroSchemaValidatorService without demoting to extra', () => {
      const validator = new ZoteroSchemaValidatorService(new TypesService());
      const res = validator.validateAndSanitizeItem('journalArticle', {
        title: 'External Client Payload',
        __isSystemUpdate: true,
        __updateSource: 'CrossRef',
        extraFields: {
          __isSystemUpdate: true,
          __updateSource: 'Spoofed',
        },
      });

      expect(res.sanitizedItem.__isSystemUpdate).toBeUndefined();
      expect(res.sanitizedItem.__updateSource).toBeUndefined();
      expect(
        (res.sanitizedItem.extraFields as Record<string, unknown>)
          ?.__isSystemUpdate,
      ).toBeUndefined();
      expect(res.demotedToExtra.__isSystemUpdate).toBeUndefined();
      expect(res.demotedToExtra.__updateSource).toBeUndefined();
      expect(res.sanitizedItem.extra).toBeUndefined();
    });

    it('4d: guards UUID columns against non-UUID values in ConditionEvaluatorEngine', () => {
      const engine = new ConditionEvaluatorEngine();
      const validUuid = '550e8400-e29b-41d4-a716-446655440000';

      const validWhere = engine.compile('user-1', {
        operator: 'AND',
        conditions: [
          { field: 'projectId', operator: 'is', value: validUuid },
        ],
      });
      expect(JSON.stringify(validWhere)).toContain(validUuid);

      const invalidIsWhere = engine.compile('user-1', {
        operator: 'AND',
        conditions: [
          { field: 'projectId', operator: 'is', value: 'not-a-uuid' },
        ],
      });
      expect(JSON.stringify(invalidIsWhere)).toContain(
        '00000000-0000-0000-0000-000000000000',
      );
      expect(JSON.stringify(invalidIsWhere)).not.toContain('not-a-uuid');

      const invalidIsNotWhere = engine.compile('user-1', {
        operator: 'AND',
        conditions: [
          { field: 'projectId', operator: 'isNot', value: 'not-a-uuid' },
        ],
      });
      expect(JSON.stringify(invalidIsNotWhere)).toContain(
        '00000000-0000-0000-0000-000000000000',
      );
    });
  });

  describe('Fix 5: Tag, Author, RIS/CSL Parser, Rate Limiter & WebFetchLadder Guards', () => {
    it('preserves .NET framework tags while still rejecting web domains', () => {
      expect(cleanSingleTag('.NET')).toBe('.NET');
      expect(cleanSingleTag('ASP.NET Core')).toBe('ASP.NET Core');
      expect(cleanSingleTag('ML.NET')).toBe('ML.NET');
      expect(cleanSingleTag('.NET 8')).toBe('.NET 8');
      expect(normalizeAcademicTags(['.NET, ASP.NET, example.net, arxiv.org'])).toEqual([
        '.NET',
        'ASP.NET',
      ]);
    });

    it('preserves institutional hospital/clinic creators while rejecting department affiliation lines', () => {
      expect(isNoiseAuthorName('Mayo Clinic')).toBe(false);
      expect(isNoiseAuthorName('Cleveland Clinic')).toBe(false);
      expect(isNoiseAuthorName('Massachusetts General Hospital')).toBe(false);
      expect(cleanAuthorName('Mayo Clinic')).toBe('Mayo Clinic');

      const parsed = parseCreatorString('Mayo Clinic');
      expect(parsed.fieldMode).toBe(1);
      expect(parsed.lastName).toBe('Mayo Clinic');

      const merged = mergeCanonicalCreators({
        creators: [
          { lastName: 'Mayo Clinic', fieldMode: 1 },
          { name: 'Massachusetts General Hospital' },
        ],
      });
      expect(merged).toHaveLength(2);
      expect(merged?.[0]).toEqual(
        expect.objectContaining({
          lastName: 'Mayo Clinic',
          fieldMode: 1,
        }),
      );

      // Department / location affiliation lines are still rejected as noise
      expect(isNoiseAuthorName('Division of Cardiology, Mayo Clinic')).toBe(true);
      expect(isNoiseAuthorName('Department of Medical Imaging')).toBe(true);
    });

    it('extracts short 1-to-4 digit PMIDs and PMCIDs in RIS and CSL parsers', () => {
      expect(extractIdentifiersFromText('N1', 'PMID: 123; PMCID: PMC45')).toEqual({
        pmid: '123',
        pmcid: 'PMC45',
        arxivId: undefined,
      });
      expect(extractIdentifiersFromText('AN', '42', true)).toEqual({
        pmid: '42',
        pmcid: undefined,
        arxivId: undefined,
      });

      const cslParser = new CslParser();
      const items = cslParser.parse(
        JSON.stringify([
          {
            type: 'article-journal',
            title: 'Classic 1975 Biochemistry Paper',
            note: 'PMID: 123\nPMCID: PMC456\nCustom Note Line',
          },
        ]),
      );
      expect(items).toHaveLength(1);
      expect(items[0].pmid).toBe('123');
      expect(items[0].pmcid).toBe('PMC456');
      expect(items[0].extra).toBe('Custom Note Line');
    });

    it('aborts queued DomainRateLimiterService.acquire immediately without waiting for slow prior chain', async () => {
      const limiter = new DomainRateLimiterService();
      limiter.setDomainConfig('slow.example.org', { minIntervalMs: 5000 });

      // First request acquires immediately and sets lastExecutionTime = now
      await limiter.acquire('slow.example.org');

      // Second request will sleep for ~5000ms holding the domain chain
      const abortSecond = new AbortController();
      const secondPromise = limiter.acquire(
        'slow.example.org',
        abortSecond.signal,
      );

      // Third request is queued behind the second request, but aborts after 20ms
      const abortThird = new AbortController();
      const start = Date.now();
      setTimeout(() => abortThird.abort(new Error('FastCallerAbort')), 20);

      await expect(
        limiter.acquire('slow.example.org', abortThird.signal),
      ).rejects.toThrow('FastCallerAbort');
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(500);

      // Clean up second request
      abortSecond.abort(new Error('CleanupSecond'));
      await expect(secondPromise).rejects.toThrow('CleanupSecond');
    });

    it('rejects WAF / Cloudflare challenge HTML returned by Step 3 stealth proxy in WebFetchLadderService', async () => {
      const verifier = new IngestionVerifierService();
      const ssrfGuard = {
        assertSafeUrl: jest.fn().mockResolvedValue(undefined),
      } as unknown as SsrfGuardService;
      const rateLimiter = new DomainRateLimiterService();
      rateLimiter.bypassDelay = true;

      const ladder = new WebFetchLadderService(
        ssrfGuard,
        verifier,
        rateLimiter,
      );

      jest
        .spyOn(
          ladder as unknown as {
            fetchWithSafeRedirects: () => Promise<{
              response: Response;
              finalUrl: string;
            }>;
          },
          'fetchWithSafeRedirects',
        )
        .mockResolvedValue({
          finalUrl: 'https://publisher.example.com/paper',
          response: {
            ok: false,
            status: 403,
            url: 'https://publisher.example.com/paper',
            headers: new Headers({ 'content-type': 'text/html' }),
          } as unknown as Response,
        });

      jest
        .spyOn(
          ladder as unknown as {
            resolveOpenAlex: () => Promise<null>;
          },
          'resolveOpenAlex',
        )
        .mockResolvedValue(null);

      jest
        .spyOn(
          ladder as unknown as {
            executeStealthFetch: () => Promise<{ status: number; text: string }>;
          },
          'executeStealthFetch',
        )
        .mockResolvedValue({
          status: 200,
          text: '<html><head><title>Just a moment...</title></head><body><div id="cf-turnstile">Checking your browser before accessing...</div></body></html>',
        });

      const res = await ladder.fetch(
        'https://publisher.example.com/paper',
      );
      expect(res.isBlocked).toBe(true);
      expect(res.ladderStepReached).toBe(4);
      expect(res.bodyText).toBeUndefined();
    });
  });
});
