/**
 * Unit tests for Zero-Hardware-Scale Ingestion Optimizations:
 * 1. Global Content-Addressable PDF Extraction Cache (`SHA-256` CAS) + In-Flight Coalescing in `IdentifyFileResolver`
 * 2. Native Bulk Resolution (`ArxivProvider.resolveBatch` & `OpenAlexProvider.resolveDoiBatch`)
 * 3. Dynamic Micro-Batching (`35ms` window) in `MetadataExecutorService`
 */
import { IdentifyFileResolver } from '@/modules/library/ingestion/stages/identify-file.resolver';
import { NormalizationPolicy } from '@/modules/library/ingestion/domain/normalization.policy';
import { ArxivProvider } from '@/modules/library/ingestion/providers/arxiv.provider';
import { OpenAlexProvider } from '@/modules/library/ingestion/providers/openalex.provider';
import { MetadataExecutorService } from '@/modules/library/ingestion/services/metadata-executor.service';
import type { IStoragePort } from '@/modules/storage/storage.port';
import type { IExtractionFacade } from '@/modules/library/core';

describe('High-Scale Ingestion Architecture Optimizations', () => {
  describe('Pillar 1 — Global Content-Addressable PDF Extraction Cache (IdentifyFileResolver)', () => {
    it('parses identical PDF buffer (same SHA-256) only ONCE across 20 concurrent/sequential uploads while preserving per-user filename fallback', async () => {
      const sharedPdfBuffer = Buffer.from(
        '%PDF-1.7 shared canonical paper binary content 10.1038/s41586-021-03819-2',
        'utf-8',
      );

      const readOwnedFileMock = jest.fn().mockImplementation(async ({ fileId }) => ({
        fileId,
        buffer: sharedPdfBuffer,
        mimeType: 'application/pdf',
      }));

      const extractTrustedMetadataMock = jest.fn().mockResolvedValue({
        metadata: {
          title: 'Highly accurate protein structure prediction with AlphaFold',
          doi: '10.1038/s41586-021-03819-2',
          authors: ['Jumper, John', 'Evans, Richard'],
          year: 2021,
        },
        isSelfSufficient: true,
        quality: { totalScore: 0.96 },
        provenance: { engineUsed: 'XMP+LAYOUT' },
      });

      const extractDocumentFromBufferMock = jest.fn();

      const storagePort = {
        readOwnedFile: readOwnedFileMock,
      } as unknown as IStoragePort;

      const extractionGateway = {
        extractTrustedMetadata: extractTrustedMetadataMock,
        extractDocumentFromBuffer: extractDocumentFromBufferMock,
      } as unknown as IExtractionFacade;

      const resolver = new IdentifyFileResolver(
        new NormalizationPolicy(),
        storagePort,
        extractionGateway,
      );

      // Simulate 20 different students concurrently uploading the exact same PDF file
      const concurrentUploads = Array.from({ length: 20 }, (_, i) =>
        resolver.resolve(
          {
            kind: 'FILE',
            fileId: `file-uuid-${i + 1}`,
            filename: `student_${i + 1}_copy_alphafold.pdf`,
          },
          { userId: `user-${i + 1}` },
        ),
      );

      const candidates = await Promise.all(concurrentUploads);

      expect(candidates).toHaveLength(20);
      // PDF extraction engine MUST be invoked only ONCE for all 20 uploads!
      expect(extractTrustedMetadataMock).toHaveBeenCalledTimes(1);
      expect(extractDocumentFromBufferMock).not.toHaveBeenCalled();

      // Verify a subsequent 21st upload hits the SHA-256 L1 cache in 0ms without calling PDF.js
      const lateUpload = await resolver.resolve(
        {
          kind: 'FILE',
          fileId: 'file-uuid-21',
          filename: 'late_student_upload.pdf',
        },
        { userId: 'user-21' },
      );

      expect(extractTrustedMetadataMock).toHaveBeenCalledTimes(1);
      expect(lateUpload.normalizedMetadata.doi).toBe('10.1038/s41586-021-03819-2');
      expect(lateUpload.normalizedMetadata.title).toBe(
        'Highly accurate protein structure prediction with AlphaFold',
      );
      expect(lateUpload.sourceRecordId).toBe('file-uuid-21');
    });
  });

  describe('Pillar 2 — Native Batch APIs & Dynamic Micro-Batching (MetadataExecutorService)', () => {
    it('coalesces 15 concurrent ArxivProvider.resolve calls into a SINGLE batch HTTP request via ?id_list=', async () => {
      const provider = new ArxivProvider();
      const fetchSpy = jest
        .spyOn(
          provider as unknown as {
            fetchTextWithResilience: (...args: unknown[]) => Promise<string>;
          },
          'fetchTextWithResilience',
        )
        .mockImplementation(async (url: unknown) => {
          const urlStr = String(url);
          const idListMatch = urlStr.match(/id_list=([^&]+)/);
          const ids = idListMatch
            ? decodeURIComponent(idListMatch[1]!).split(',')
            : [];
          const entriesXml = ids
            .map(
              (id, idx) => `
            <entry>
              <id>http://arxiv.org/abs/${id}v1</id>
              <published>2023-03-${String((idx % 28) + 1).padStart(2, '0')}T00:00:00Z</published>
              <title>Scalable Paper Title ${id}</title>
              <summary>Abstract for arXiv paper ${id} in high-scale batch test.</summary>
              <author><name>Alice Researcher</name></author>
              <arxiv:primary_category term="cs.LG"/>
              <category term="cs.LG"/>
            </entry>`,
            )
            .join('\n');
          return `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">${entriesXml}</feed>`;
        });

      const executor = new MetadataExecutorService();
      const arxivIds = Array.from(
        { length: 15 },
        (_, i) => `2303.${String(10000 + i)}`,
      );

      const executions = await Promise.all(
        arxivIds.map((query) =>
          executor.execute(provider, { query, queryType: 'ARXIV' }),
        ),
      );

      // 15 concurrent arXiv lookups MUST be coalesced into 1 single HTTP request!
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? '');
      expect(calledUrl).toContain('id_list=');
      expect(calledUrl).toContain('max_results=15');

      for (let i = 0; i < arxivIds.length; i++) {
        expect(executions[i]?.status).toBe('found');
        expect(executions[i]?.result?.metadata.arxivId).toBe(arxivIds[i]);
        expect(executions[i]?.result?.metadata.title).toBe(
          `Scalable Paper Title ${arxivIds[i]}`,
        );
      }
    });

    it('coalesces 12 concurrent OpenAlex DOI lookups into a SINGLE batch HTTP request via ?filter=doi:d1|d2|...', async () => {
      const provider = new OpenAlexProvider();
      const fetchSpy = jest
        .spyOn(
          provider as unknown as {
            executeFetch: (url: string) => Promise<Response>;
          },
          'executeFetch',
        )
        .mockImplementation(async (url: string) => {
          const results = Array.from({ length: 12 }, (_, i) => {
            const doi = `10.1038/s41586-024-000${String(i).padStart(2, '0')}-x`;
            return {
              id: `https://openalex.org/W${1000 + i}`,
              doi: `https://doi.org/${doi}`,
              title: `OpenAlex Batched Work ${i}`,
              display_name: `OpenAlex Batched Work ${i}`,
              publication_year: 2024,
              publication_date: '2024-05-01',
              type: 'article',
              authorships: [
                {
                  author: { display_name: ' Jane Doe ' },
                },
              ],
            };
          });
          return {
            status: 200,
            ok: true,
            json: async () => ({ results }),
            headers: new Headers(),
          } as unknown as Response;
        });

      const executor = new MetadataExecutorService();
      const dois = Array.from(
        { length: 12 },
        (_, i) => `10.1038/s41586-024-000${String(i).padStart(2, '0')}-x`,
      );

      const executions = await Promise.all(
        dois.map((query) =>
          executor.execute(provider, { query, queryType: 'DOI' }),
        ),
      );

      // 12 concurrent DOI lookups MUST be coalesced into 1 single HTTP request!
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = String(fetchSpy.mock.calls[0]?.[0] ?? '');
      expect(calledUrl).toContain('filter=doi:');
      expect(calledUrl).toContain('|');

      for (let i = 0; i < dois.length; i++) {
        expect(executions[i]?.status).toBe('found');
        expect(executions[i]?.result?.metadata.doi).toBe(dois[i]);
        expect(executions[i]?.result?.metadata.title).toBe(
          `OpenAlex Batched Work ${i}`,
        );
      }
    });
  });

  describe('Pillar 4: Deep-Edge Client-Resolved PDF Overrides & Citation-Trap Guard', () => {
    it('accepts matching _clientResolved edge overrides on FILE candidates and rejects conflicting page-1 citation traps', async () => {
      const { applyUserOverridesToCandidate } = await import(
        '../../../../src/modules/library/ingestion/domain/metadata-validation.policy'
      );
      const { NormalizationPolicy } = await import(
        '../../../../src/modules/library/ingestion/domain/normalization.policy'
      );
      const { evaluateCandidateEnrichmentReadiness } = await import(
        '../../../../src/modules/library/ingestion/stages/resolve.stage'
      );
      const normalizer = new NormalizationPolicy();

      // Case A: Browser edge sniffed the true DOI of the PDF (titles match)
      const matchingCandidate = applyUserOverridesToCandidate(
        {
          id: 'cand-match',
          sourceKind: 'FILE',
          rawData: {},
          fields: {},
          normalizedMetadata: {
            title: 'Attention Is All You Need',
            authors: ['Ashish Vaswani'],
          },
          confidenceScore: 0.8,
        },
        {
          _clientResolved: true,
          title: 'Attention Is All You Need',
          authors: ['Ashish Vaswani', 'Noam Shazeer'],
          year: 2017,
          publicationTitle: 'NeurIPS',
          abstract:
            'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks in an encoder-decoder configuration.',
          doi: '10.48550/arxiv.1706.03762',
        },
        normalizer,
      );

      expect(matchingCandidate.normalizedMetadata.publicationTitle).toBe(
        'NeurIPS',
      );
      expect(matchingCandidate.normalizedMetadata.year).toBe(2017);
      const readinessMatch =
        evaluateCandidateEnrichmentReadiness(matchingCandidate);
      expect(readinessMatch.shouldSkip).toBe(true);
      expect(readinessMatch.skipReason).toBe('already_complete');

      // Case B: Browser edge sniffed a CITED paper's DOI on page 1 (Citation Trap!)
      const citationTrapCandidate = applyUserOverridesToCandidate(
        {
          id: 'cand-trap',
          sourceKind: 'FILE',
          rawData: {},
          fields: {},
          normalizedMetadata: {
            title: 'A Novel Quantum Graph Neural Network for Drug Discovery',
            authors: ['Alice Nguyen', 'Bob Tran'],
          },
          confidenceScore: 0.8,
        },
        {
          _clientResolved: true,
          title: 'Deep Residual Learning for Image Recognition',
          authors: ['Kaiming He', 'Xiangyu Zhang'],
          year: 2016,
          publicationTitle: 'CVPR',
          abstract:
            'Deeper neural networks are more difficult to train. We present a residual learning framework to ease the training of networks.',
          doi: '10.1109/cvpr.2016.90',
        },
        normalizer,
      );

      // Must preserve the PDF's true title and reject the cited paper's metadata!
      expect(citationTrapCandidate.normalizedMetadata.title).toBe(
        'A Novel Quantum Graph Neural Network for Drug Discovery',
      );
      expect(
        citationTrapCandidate.normalizedMetadata.publicationTitle,
      ).toBeUndefined();

      // Case C: Filename-only PDF ("scan_01.pdf") where edge sniffed a DOI
      // Must preserve hadOnlyFilenameTitleBeforeEdge=true so ResolveStage/PipelineService
      // does not prematurely skip verification or trigger a false-positive early duplicate merge.
      const filenameOnlyCandidate = applyUserOverridesToCandidate(
        {
          id: 'cand-fn-only',
          sourceKind: 'FILE',
          rawData: {},
          fields: {},
          normalizedMetadata: {
            title: 'scan 01',
            extraFields: { isFilenameTitle: true },
          },
          confidenceScore: 0.45,
        },
        {
          _clientResolved: true,
          title: 'Deep Residual Learning for Image Recognition',
          authors: ['Kaiming He'],
          year: 2016,
          publicationTitle: 'CVPR',
          abstract:
            'Deeper neural networks are more difficult to train. We present a residual learning framework to ease the training of networks.',
          doi: '10.1109/cvpr.2016.90',
        },
        normalizer,
      );

      expect(
        (
          filenameOnlyCandidate.normalizedMetadata.extraFields as Record<
            string,
            unknown
          >
        )?.hadOnlyFilenameTitleBeforeEdge,
      ).toBe(true);
      const readinessFnOnly = evaluateCandidateEnrichmentReadiness(
        filenameOnlyCandidate,
      );
      expect(readinessFnOnly.shouldSkip).toBe(false);
    });
  });
});

