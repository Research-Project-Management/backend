import { FileHashVo } from '../../src/modules/library/reader/domain/value-objects/file-hash.vo';
import { MimeTypeVo } from '../../src/modules/library/reader/domain/value-objects/mime-type.vo';
import { AttachmentAggregate } from '../../src/modules/library/reader/domain/model/attachment.aggregate';
import { IngestionStatusVo } from '../../src/modules/library/ingestion/domain/value-objects/ingestion-status.vo';
import { IngestionRunAggregate } from '../../src/modules/library/ingestion/domain/model/ingestion-run.aggregate';
import { SearchQueryVo } from '../../src/modules/library/search/domain/value-objects/search-query.vo';
import { CitationStyleVo } from '../../src/modules/library/citation/domain/value-objects/citation-style.vo';
import { ExecuteSearchUseCase } from '../../src/modules/library/search/application/queries/execute-search.use-case';
import { FormatCitationUseCase } from '../../src/modules/library/citation/application/queries/format-citation.use-case';
import { ISearchEnginePort } from '../../src/modules/library/search/domain/ports/search-engine.port';
import { ICitationEnginePort } from '../../src/modules/library/citation/domain/ports/citation-engine.port';

describe('Reader, Ingestion, Search & Citation Bounded Contexts - Clean Architecture & DDD', () => {
  describe('Content Bounded Context', () => {
    it('FileHashVo should validate MD5 and SHA-256 hex formats', () => {
      const validMd5 = 'd41d8cd98f00b204e9800998ecf8427e';
      const vo = FileHashVo.create(validMd5);
      expect(vo).not.toBeNull();
      expect(vo?.value).toBe(validMd5);

      expect(() => FileHashVo.create('not-a-valid-hex-hash')).toThrow();
      expect(FileHashVo.create(null)).toBeNull();
    });

    it('MimeTypeVo should validate MIME type format', () => {
      const pdfVo = MimeTypeVo.create('application/pdf');
      expect(pdfVo.isPdf).toBe(true);
      expect(pdfVo.value).toBe('application/pdf');

      expect(() => MimeTypeVo.create('invalid_mime')).toThrow();
      expect(MimeTypeVo.create(null).value).toBe('application/pdf');
    });

    it('AttachmentAggregate should track revisions and emit events', () => {
      const attachment = AttachmentAggregate.create({
        itemId: 'item-1',
        filename: 'paper.pdf',
        url: 'https://storage.flux.local/files/paper.pdf',
        sizeBytes: 1048576,
      });

      expect(attachment.id).toBeDefined();
      expect(attachment.revisionCount).toBe(1);
      expect(attachment.isPdf).toBe(true);
      expect(attachment.isExtracted).toBe(false);

      const events1 = attachment.pullDomainEvents();
      expect(events1).toHaveLength(1);
      expect(events1[0].eventType).toBe('content.attachment.created');

      // Add a revision
      attachment.addRevision(
        'https://storage.flux.local/files/paper_v2.pdf',
        1050000,
      );
      expect(attachment.revisionCount).toBe(2);
      expect(attachment.sizeBytes).toBe(1050000);

      // Mark as extracted
      attachment.markExtracted(12);
      expect(attachment.isExtracted).toBe(true);
      expect(attachment.pageCount).toBe(12);

      const events2 = attachment.pullDomainEvents();
      expect(events2).toHaveLength(2);
      expect(events2[0].eventType).toBe('content.attachment.revision_added');
      expect(events2[1].eventType).toBe('content.attachment.extracted');
    });
  });

  describe('Processing Bounded Context', () => {
    it('IngestionStatusVo should enforce valid state transitions', () => {
      const pending = IngestionStatusVo.create('PENDING');
      const running = IngestionStatusVo.create('RUNNING');
      const completed = IngestionStatusVo.create('COMPLETED');

      expect(pending.canTransitionTo(running)).toBe(true);
      expect(pending.canTransitionTo(completed)).toBe(false); // Cannot jump directly to completed
      expect(running.canTransitionTo(completed)).toBe(true);
      expect(completed.canTransitionTo(running)).toBe(false); // Terminal state
    });

    it('IngestionRunAggregate should manage pipeline lifecycle and record progress', () => {
      const run = IngestionRunAggregate.create({
        userId: 'user-1',
        sourceType: 'bibtex',
        totalItems: 10,
      });

      expect(run.status).toBe('RUNNING');
      expect(run.totalItems).toBe(10);
      expect(run.processedItems).toBe(0);

      const startEvents = run.pullDomainEvents();
      expect(startEvents).toHaveLength(1);
      expect(startEvents[0].eventType).toBe('processing.ingestion_run.started');

      run.recordProgress(5, 0);
      expect(run.processedItems).toBe(5);

      run.complete();
      expect(run.status).toBe('COMPLETED');
      expect(run.completedAt).toBeDefined();

      const completeEvents = run.pullDomainEvents();
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0].eventType).toBe(
        'processing.ingestion_run.completed',
      );
    });
  });

  describe('Search Bounded Context', () => {
    it('SearchQueryVo should enforce limits and sanitize parameters', () => {
      const query = SearchQueryVo.create('  quantum computing  ', {
        limit: 500, // Should be clamped to 100
        offset: -10, // Should be clamped to 0
        sortBy: 'date',
      });

      expect(query.query).toBe('quantum computing');
      expect(query.limit).toBe(100);
      expect(query.offset).toBe(0);
      expect(query.sortBy).toBe('date');
    });

    it('ExecuteSearchUseCase should delegate to search engine port', async () => {
      const mockSearchEngine: jest.Mocked<ISearchEnginePort> = {
        search: jest.fn().mockResolvedValue({
          hits: [{ id: 'item-1', title: 'Deep Learning', score: 0.95 }],
          total: 1,
        }),
      };

      const useCase = new ExecuteSearchUseCase(mockSearchEngine);
      const result = await useCase.execute({
        userId: 'user-1',
        query: 'deep learning',
        limit: 10,
      });

      expect(mockSearchEngine.search).toHaveBeenCalledTimes(1);
      expect(result.hits).toHaveLength(1);
      expect(result.hits[0].title).toBe('Deep Learning');
    });
  });

  describe('Citation Bounded Context', () => {
    it('CitationStyleVo should validate academic styles', () => {
      const apa = CitationStyleVo.create('APA');
      expect(apa.value).toBe('apa');

      const unsupported = CitationStyleVo.create('unsupported-style');
      expect(unsupported.value).toBe('apa'); // Fallback
    });

    it('FormatCitationUseCase should delegate to citation engine port', async () => {
      const mockCitationEngine: jest.Mocked<ICitationEnginePort> = {
        formatItem: jest.fn().mockResolvedValue({
          formattedText: 'LeCun, Y. (2015). Deep learning.',
          style: 'apa',
          itemId: 'item-1',
        }),
        formatBatch: jest.fn().mockResolvedValue([]),
      };

      const useCase = new FormatCitationUseCase(mockCitationEngine);
      const result = await useCase.execute({
        userId: 'user-1',
        itemId: 'item-1',
        style: 'apa',
      });

      expect(mockCitationEngine.formatItem).toHaveBeenCalledTimes(1);
      expect(result?.formattedText).toBe('LeCun, Y. (2015). Deep learning.');
    });
  });
});
