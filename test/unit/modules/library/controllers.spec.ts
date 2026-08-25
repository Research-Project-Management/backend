import { CatalogController } from '@/modules/library/catalog/catalog.controller';
import { CollectionsController } from '@/modules/library/collections/collections.controller';
import { IngestionController } from '@/modules/library/ingestion/ingestion.controller';
import { CitationController } from '@/modules/library/citation/citation.controller';
import { AttachmentsController } from '@/modules/library/attachments/attachments.controller';
import { KnowledgeController } from '@/modules/library/knowledge/knowledge.controller';
import { QualityController } from '@/modules/library/quality/quality.controller';
import { AcademicBundleController } from '@/modules/library/academic-bundle/academic-bundle.controller';
import { IngestionSourceType } from '@/modules/library/ingestion/dto/ingestion.dto';

describe('Library Subsystem: Complete Controllers & Endpoints Verification', () => {
  let catalogController: CatalogController;
  let collectionsController: CollectionsController;
  let ingestionController: IngestionController;
  let citationController: CitationController;
  let attachmentsController: AttachmentsController;
  let knowledgeController: KnowledgeController;
  let qualityController: QualityController;
  let academicBundleController: AcademicBundleController;

  const mockCatalogService: any = {
    ingestPaper: jest.fn().mockResolvedValue({ id: 'p1', title: 'Paper 1' }),
    getPapers: jest.fn().mockResolvedValue({ papers: [], total: 0 }),
    getWorkspaceTags: jest.fn().mockResolvedValue({ tags: ['ai'] }),
    uploadPaper: jest.fn().mockResolvedValue({ id: 'p1' }),
    importFromStorage: jest.fn().mockResolvedValue({ id: 'p1' }),
    getPaperById: jest.fn().mockResolvedValue({ id: 'p1' }),
    addAttachment: jest.fn().mockResolvedValue({ id: 'att1' }),
    removeAttachment: jest.fn().mockResolvedValue({ success: true }),
    triggerReindex: jest.fn().mockResolvedValue({ status: 'queued' }),
    triggerReindexInWorkspace: jest
      .fn()
      .mockResolvedValue({ status: 'queued' }),
    updatePaper: jest.fn().mockResolvedValue({ id: 'p1' }),
    deleteItem: jest.fn().mockResolvedValue({ deleted: true }),
    deleteItemInWorkspace: jest.fn().mockResolvedValue({ deleted: true }),
    exportBibtex: jest.fn().mockResolvedValue('@article{...}'),
  };

  const mockCollectionsService: any = {
    getCollections: jest.fn().mockResolvedValue([]),
    createCollection: jest.fn().mockResolvedValue({ collection: { id: 'c1' } }),
    getCollectionById: jest.fn().mockResolvedValue({ id: 'c1' }),
    updateCollection: jest.fn().mockResolvedValue({ id: 'c1' }),
    deleteCollection: jest.fn().mockResolvedValue({ message: 'deleted' }),
    movePapers: jest.fn().mockResolvedValue({ count: 1 }),
    reorderCollections: jest.fn().mockResolvedValue([]),
    assignPapersToCollection: jest
      .fn()
      .mockResolvedValue({ message: 'assigned' }),
    detachPaperFromCollection: jest
      .fn()
      .mockResolvedValue({ message: 'detached' }),
    exportCollectionBibtex: jest
      .fn()
      .mockResolvedValue({ bibtex: '@article{}' }),
    getCollectionExportBundle: jest.fn().mockResolvedValue({ manifest: [] }),
  };

  const mockIngestionService: any = {
    ingest: jest.fn().mockResolvedValue({ id: 'p1', title: 'Ingested Paper' }),
    batchIngest: jest.fn().mockResolvedValue({ successful: 1, items: [] }),
  };

  const mockIngestionJobService: any = {
    createAsyncBatchJob: jest
      .fn()
      .mockResolvedValue({ jobId: 'job-123', status: 'processing' }),
    getJobStatus: jest
      .fn()
      .mockResolvedValue({ jobId: 'job-123', status: 'completed' }),
  };

  const mockCitationService: any = {
    formatCitation: jest
      .fn()
      .mockResolvedValue({ style: 'apa', inText: '(Author, 2026)' }),
    formatBatchCitations: jest
      .fn()
      .mockResolvedValue({ total: 1, entries: [] }),
    resolve: jest.fn().mockResolvedValue({ metadata: { title: 'Resolved' } }),
    resolveDoi: jest.fn().mockResolvedValue({ title: 'Resolved DOI' }),
    createReference: jest.fn().mockResolvedValue({ reference: { id: 'ref1' } }),
    exportWorkspaceBibtex: jest
      .fn()
      .mockResolvedValue({ bibtex: '@article{}', total: 1 }),
    importBibtex: jest.fn().mockResolvedValue({ imported: 1, papers: [] }),
    parseRis: jest.fn().mockResolvedValue({ total: 1, entries: [] }),
    importRis: jest.fn().mockResolvedValue({ imported: 1, papers: [] }),
    exportRis: jest
      .fn()
      .mockResolvedValue({ ris: 'TY  - JOUR', filename: 'paper.ris' }),
  };

  const mockAnnotationsService: any = {
    getAnnotations: jest.fn().mockResolvedValue({ annotations: [], total: 0 }),
    createAnnotation: jest
      .fn()
      .mockResolvedValue({ annotation: { id: 'ann-1' } }),
    updateAnnotation: jest
      .fn()
      .mockResolvedValue({ annotation: { id: 'ann-1' } }),
    deleteAnnotation: jest
      .fn()
      .mockResolvedValue({ deleted: true, remainingCount: 0 }),
    extractNotesFromAnnotations: jest
      .fn()
      .mockResolvedValue({ literatureNote: { title: 'Note', content: 'MD' } }),
    extractLiteratureNotes: jest
      .fn()
      .mockResolvedValue({ literatureNote: { title: 'Note', content: 'MD' } }),
  };

  const mockKnowledgeService: any = {
    getRelatedPapers: jest
      .fn()
      .mockResolvedValue({ relatedItems: [], total: 0 }),
    linkPapers: jest
      .fn()
      .mockResolvedValue({ success: true, link: { type: 'extends' } }),
    unlinkPapers: jest.fn().mockResolvedValue({ success: true }),
    getWorkspaceKnowledgeGraph: jest
      .fn()
      .mockResolvedValue({ nodes: [], edges: [] }),
  };

  const mockQualityService: any = {
    getDuplicateGroups: jest.fn().mockResolvedValue({ duplicateGroups: [] }),
    mergePapers: jest
      .fn()
      .mockResolvedValue({ mergedCount: 1, softDeletedPaperIds: ['p2'] }),
    getIntegrityReport: jest
      .fn()
      .mockResolvedValue({ totalPapers: 1, healthyPapers: 1 }),
  };

  const mockAcademicBundleService: any = {
    getItemAcademicBundle: jest.fn().mockResolvedValue({
      item: { id: 'p1', title: 'Attention' },
      citations: { apa: { inText: '(Vaswani, 2017)' } },
      annotations: [],
      relatedItems: [],
    }),
  };

  beforeEach(() => {
    catalogController = new CatalogController(mockCatalogService);
    collectionsController = new CollectionsController(mockCollectionsService);
    ingestionController = new IngestionController(
      mockIngestionService,
      mockIngestionJobService,
    );
    citationController = new CitationController(mockCitationService);
    const mockAttachmentsService: any = { extractFromPdf: jest.fn() };
    attachmentsController = new AttachmentsController(
      mockAnnotationsService,
      mockAttachmentsService,
    );
    knowledgeController = new KnowledgeController(mockKnowledgeService);
    qualityController = new QualityController(mockQualityService);
    academicBundleController = new AcademicBundleController(
      mockAcademicBundleService,
    );
  });

  describe('1. CatalogController Endpoints', () => {
    it('should route ingestPaper, getPapers, getWorkspaceTags, and uploadPaper', async () => {
      await catalogController.ingestPaper('ws-1', 'u-1', { title: 'Paper' });
      expect(mockCatalogService.ingestPaper).toHaveBeenCalledWith(
        'ws-1',
        'u-1',
        {
          title: 'Paper',
        },
      );

      await catalogController.getPapers('ws-1', 'col-1', 'search-term');
      expect(mockCatalogService.getPapers).toHaveBeenCalledWith(
        'ws-1',
        expect.objectContaining({ collectionId: 'col-1' }),
      );

      await catalogController.getWorkspaceTags('ws-1');
      expect(mockCatalogService.getWorkspaceTags).toHaveBeenCalledWith('ws-1');

      await catalogController.uploadPaper('ws-1', 'u-1', {
        title: 'P1',
        filename: 'p1.pdf',
        fileUrl: 'https://r2/p1.pdf',
      });
      expect(mockCatalogService.uploadPaper).toHaveBeenCalledWith(
        'ws-1',
        'u-1',
        expect.any(Object),
      );

      await catalogController.triggerReindex('ws-1', 'p-1', 'u-1');
      expect(mockCatalogService.triggerReindexInWorkspace).toHaveBeenCalledWith(
        'ws-1',
        'p-1',
        'u-1',
      );

      await catalogController.deleteItem('ws-1', 'p-1');
      expect(mockCatalogService.deleteItemInWorkspace).toHaveBeenCalledWith(
        'ws-1',
        'p-1',
      );
    });
  });

  describe('2. CollectionsController Endpoints', () => {
    it('should route getCollections, createCollection, movePapers, and exportCollectionBundle', async () => {
      await collectionsController.getCollections('ws-1');
      expect(mockCollectionsService.getCollections).toHaveBeenCalledWith(
        'ws-1',
      );

      await collectionsController.createCollection('ws-1', 'u-1', {
        name: 'Deep Learning',
      });
      expect(mockCollectionsService.createCollection).toHaveBeenCalledWith(
        'ws-1',
        'u-1',
        { name: 'Deep Learning' },
      );

      await collectionsController.movePapers('ws-1', 'col-1', {
        paperIds: ['p1'],
      });
      expect(mockCollectionsService.movePapers).toHaveBeenCalledWith(
        'ws-1',
        'col-1',
        ['p1'],
      );

      await collectionsController.exportCollectionBundle('ws-1', 'col-1');
      expect(
        mockCollectionsService.getCollectionExportBundle,
      ).toHaveBeenCalledWith('ws-1', 'col-1');
    });
  });

  describe('3. IngestionController Endpoints', () => {
    it('should route ingest, batchIngest, createAsyncBatchJob, and getJobStatus', async () => {
      await ingestionController.ingest('ws-1', 'u-1', {
        workspaceId: 'ws-1',
        sourceType: IngestionSourceType.DOI,
        doi: '10.1000/182',
      });
      expect(mockIngestionService.ingest).toHaveBeenCalledWith(
        'ws-1',
        'u-1',
        expect.any(Object),
      );

      await ingestionController.batchIngest('ws-1', 'u-1', { items: [] });
      expect(mockIngestionService.batchIngest).toHaveBeenCalledWith(
        'ws-1',
        'u-1',
        {
          items: [],
        },
      );

      await ingestionController.createAsyncBatchJob('ws-1', 'u-1', {
        items: [],
      });
      expect(
        mockIngestionJobService.createAsyncBatchJob,
      ).toHaveBeenCalledWith('ws-1', 'u-1', { items: [] });

      await ingestionController.getJobStatus('ws-1', 'job-123', 'u-1');
      expect(mockIngestionJobService.getJobStatus).toHaveBeenCalledWith(
        'job-123',
        'u-1',
      );
    });
  });

  describe('4. CitationController Endpoints', () => {
    it('should route formatCitation, formatBatchCitations, resolve, importBibtex, exportRis', async () => {
      await citationController.formatCitation('ws-1', 'p-1', {
        style: 'apa',
      });
      expect(mockCitationService.formatCitation).toHaveBeenCalledWith(
        'ws-1',
        'p-1',
        'apa',
      );

      await citationController.formatBatchCitations('ws-1', {
        paperIds: ['p1'],
        style: 'ieee',
      });
      expect(mockCitationService.formatBatchCitations).toHaveBeenCalledWith(
        'ws-1',
        expect.any(Object),
      );

      await citationController.formatCitation('ws-1', 'p-1', { style: 'apa' });
      expect(mockCitationService.formatCitation).toHaveBeenCalledWith(
        'ws-1',
        'p-1',
        'apa',
      );

      await citationController.importBibtex('ws-1', 'u-1', {
        bibtex: '@article{}',
      });
      expect(mockCitationService.importBibtex).toHaveBeenCalledWith(
        'ws-1',
        'u-1',
        { bibtex: '@article{}' },
      );

      await citationController.exportRis('ws-1', 'p-1');
      expect(mockCitationService.exportRis).toHaveBeenCalledWith('ws-1', 'p-1');
    });
  });

  describe('5. AttachmentsController annotation endpoints', () => {
    it('should route getAnnotations, createAnnotation, updateAnnotation, deleteAnnotation, extractNotes', async () => {
      await attachmentsController.getAnnotations('ws-1', 'p-1');
      expect(mockAnnotationsService.getAnnotations).toHaveBeenCalledWith(
        'ws-1',
        'p-1',
      );

      await attachmentsController.createAnnotation('ws-1', 'p-1', 'u-1', {
        type: 'highlight',
        pageNumber: 1,
        color: '#ff0',
      });
      expect(mockAnnotationsService.createAnnotation).toHaveBeenCalledWith(
        'ws-1',
        'p-1',
        'u-1',
        expect.any(Object),
      );

      await attachmentsController.updateAnnotation('ws-1', 'p-1', 'ann-1', {
        color: '#00f',
      });
      expect(mockAnnotationsService.updateAnnotation).toHaveBeenCalledWith(
        'ws-1',
        'p-1',
        'ann-1',
        { color: '#00f' },
      );

      await attachmentsController.deleteAnnotation('ws-1', 'p-1', 'ann-1');
      expect(mockAnnotationsService.deleteAnnotation).toHaveBeenCalledWith(
        'ws-1',
        'p-1',
        'ann-1',
      );

      await attachmentsController.extractLiteratureNotes('ws-1', 'p-1');
      expect(
        mockAnnotationsService.extractLiteratureNotes,
      ).toHaveBeenCalledWith('ws-1', 'p-1');
    });
  });

  describe('6. KnowledgeController Endpoints', () => {
    it('should route getRelatedPapers, linkPapers, unlinkPapers, getWorkspaceKnowledgeGraph', async () => {
      await knowledgeController.getRelatedPapers('ws-1', 'p-1');
      expect(mockKnowledgeService.getRelatedPapers).toHaveBeenCalledWith(
        'ws-1',
        'p-1',
      );

      await knowledgeController.linkPapers('ws-1', 'p-1', {
        targetPaperId: 'p-2',
        relationType: 'extends',
      });
      expect(mockKnowledgeService.linkPapers).toHaveBeenCalledWith(
        'ws-1',
        'p-1',
        expect.any(Object),
      );

      await knowledgeController.unlinkPapers('ws-1', 'p-1', 'p-2');
      expect(mockKnowledgeService.unlinkPapers).toHaveBeenCalledWith(
        'ws-1',
        'p-1',
        'p-2',
      );

      await knowledgeController.getWorkspaceKnowledgeGraph('ws-1');
      expect(
        mockKnowledgeService.getWorkspaceKnowledgeGraph,
      ).toHaveBeenCalledWith('ws-1');
    });
  });

  describe('7. QualityController Endpoints', () => {
    it('should route getDuplicateGroups, mergePapers, getIntegrityReport', async () => {
      await qualityController.getDuplicateGroups('ws-1');
      expect(mockQualityService.getDuplicateGroups).toHaveBeenCalledWith(
        'ws-1',
      );

      await qualityController.mergePapers('ws-1', 'u-1', {
        masterPaperId: 'p1',
        sourcePaperIds: ['p2'],
      });
      expect(mockQualityService.mergePapers).toHaveBeenCalledWith(
        'ws-1',
        'u-1',
        expect.any(Object),
      );

      await qualityController.getIntegrityReport('ws-1');
      expect(mockQualityService.getIntegrityReport).toHaveBeenCalledWith(
        'ws-1',
      );
    });
  });

  describe('8. AcademicBundleController Endpoint', () => {
    it('should route getItemAcademicBundle', async () => {
      const bundle = await academicBundleController.getItemAcademicBundle(
        'ws-1',
        'p-1',
      );
      expect(
        mockAcademicBundleService.getItemAcademicBundle,
      ).toHaveBeenCalledWith('ws-1', 'p-1');
      expect(bundle.item.id).toBe('p1');
    });
  });
});
