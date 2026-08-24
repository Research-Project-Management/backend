import { PaperController } from '@/modules/library/paper/paper.controller';
import { CollectionController } from '@/modules/library/collection/collection.controller';
import { IngestionController } from '@/modules/library/ingestion/ingestion.controller';
import { ReferenceController } from '@/modules/library/reference/reference.controller';
import { AnnotationController } from '@/modules/library/annotation/annotation.controller';
import { RelationController } from '@/modules/library/relation/relation.controller';
import { QualityController } from '@/modules/library/quality/quality.controller';
import { LibraryController } from '@/modules/library/library.controller';
import { IngestionSourceType } from '@/modules/library/ingestion/dto/ingestion.dto';

describe('Library Subsystem: Complete Controllers & Endpoints Verification', () => {
  let paperController: PaperController;
  let collectionController: CollectionController;
  let ingestionController: IngestionController;
  let referenceController: ReferenceController;
  let annotationController: AnnotationController;
  let relationController: RelationController;
  let qualityController: QualityController;
  let libraryController: LibraryController;

  const mockPaperService: any = {
    ingestPaper: jest.fn().mockResolvedValue({ id: 'p1', title: 'Paper 1' }),
    getPapers: jest.fn().mockResolvedValue({ papers: [], total: 0 }),
    getWorkspaceTags: jest.fn().mockResolvedValue({ tags: ['ai'] }),
    uploadPaper: jest.fn().mockResolvedValue({ id: 'p1' }),
    importFromStorage: jest.fn().mockResolvedValue({ id: 'p1' }),
    getPaperById: jest.fn().mockResolvedValue({ id: 'p1' }),
    addAttachment: jest.fn().mockResolvedValue({ id: 'att1' }),
    removeAttachment: jest.fn().mockResolvedValue({ success: true }),
    triggerReindex: jest.fn().mockResolvedValue({ status: 'queued' }),
    updatePaper: jest.fn().mockResolvedValue({ id: 'p1' }),
    deletePaper: jest.fn().mockResolvedValue({ deleted: true }),
    exportBibtex: jest.fn().mockResolvedValue('@article{...}'),
  };

  const mockCollectionService: any = {
    getCollections: jest.fn().mockResolvedValue([]),
    createCollection: jest.fn().mockResolvedValue({ collection: { id: 'c1' } }),
    getCollectionById: jest.fn().mockResolvedValue({ id: 'c1' }),
    updateCollection: jest.fn().mockResolvedValue({ id: 'c1' }),
    deleteCollection: jest.fn().mockResolvedValue({ message: 'deleted' }),
    movePapers: jest.fn().mockResolvedValue({ count: 1 }),
    reorderCollections: jest.fn().mockResolvedValue([]),
    assignPapersToCollection: jest.fn().mockResolvedValue({ message: 'assigned' }),
    detachPaperFromCollection: jest.fn().mockResolvedValue({ message: 'detached' }),
    exportCollectionBibtex: jest.fn().mockResolvedValue({ bibtex: '@article{}' }),
    getCollectionExportBundle: jest.fn().mockResolvedValue({ manifest: [] }),
  };

  const mockIngestionService: any = {
    ingest: jest.fn().mockResolvedValue({ id: 'p1', title: 'Ingested Paper' }),
    batchIngest: jest.fn().mockResolvedValue({ successful: 1, items: [] }),
    createAsyncBatchJob: jest.fn().mockResolvedValue({ jobId: 'job-123', status: 'processing' }),
    getJobStatus: jest.fn().mockResolvedValue({ jobId: 'job-123', status: 'completed' }),
  };

  const mockReferenceService: any = {
    formatPaperCitation: jest.fn().mockResolvedValue({ style: 'apa', inText: '(Author, 2026)' }),
    formatBatchCitations: jest.fn().mockResolvedValue({ total: 1, entries: [] }),
    resolve: jest.fn().mockResolvedValue({ metadata: { title: 'Resolved' } }),
    resolveDoi: jest.fn().mockResolvedValue({ title: 'Resolved DOI' }),
    createReference: jest.fn().mockResolvedValue({ reference: { id: 'ref1' } }),
    exportWorkspaceBibtex: jest.fn().mockResolvedValue({ bibtex: '@article{}', total: 1 }),
    importBibtex: jest.fn().mockResolvedValue({ imported: 1, papers: [] }),
    parseRis: jest.fn().mockResolvedValue({ total: 1, entries: [] }),
    importRis: jest.fn().mockResolvedValue({ imported: 1, papers: [] }),
    exportRis: jest.fn().mockResolvedValue({ ris: 'TY  - JOUR', filename: 'paper.ris' }),
  };

  const mockAnnotationService: any = {
    getAnnotations: jest.fn().mockResolvedValue({ annotations: [], total: 0 }),
    createAnnotation: jest.fn().mockResolvedValue({ annotation: { id: 'ann-1' } }),
    updateAnnotation: jest.fn().mockResolvedValue({ annotation: { id: 'ann-1' } }),
    deleteAnnotation: jest.fn().mockResolvedValue({ deleted: true, remainingCount: 0 }),
    extractNotesFromAnnotations: jest.fn().mockResolvedValue({ literatureNote: { title: 'Note', content: 'MD' } }),
  };

  const mockRelationService: any = {
    getRelatedPapers: jest.fn().mockResolvedValue({ relatedPapers: [], total: 0 }),
    linkPapers: jest.fn().mockResolvedValue({ success: true, link: { type: 'extends' } }),
    unlinkPapers: jest.fn().mockResolvedValue({ success: true }),
    getWorkspaceKnowledgeGraph: jest.fn().mockResolvedValue({ nodes: [], edges: [] }),
  };

  const mockQualityService: any = {
    getDuplicateGroups: jest.fn().mockResolvedValue({ duplicateGroups: [] }),
    mergePapers: jest.fn().mockResolvedValue({ mergedCount: 1, softDeletedPaperIds: ['p2'] }),
    getIntegrityReport: jest.fn().mockResolvedValue({ totalPapers: 1, healthyPapers: 1 }),
  };

  const mockLibraryService: any = {
    getPaperAcademicBundle: jest.fn().mockResolvedValue({
      paper: { id: 'p1', title: 'Attention' },
      citations: { apa: { inText: '(Vaswani, 2017)' } },
      annotations: [],
      relatedPapers: [],
    }),
  };

  beforeEach(() => {
    paperController = new PaperController(mockPaperService);
    collectionController = new CollectionController(mockCollectionService);
    ingestionController = new IngestionController(mockIngestionService);
    referenceController = new ReferenceController(mockReferenceService);
    annotationController = new AnnotationController(mockAnnotationService);
    relationController = new RelationController(mockRelationService);
    qualityController = new QualityController(mockQualityService);
    libraryController = new LibraryController(mockLibraryService);
  });

  describe('1. PaperController Endpoints', () => {
    it('should route ingestPaper, getPapers, getWorkspaceTags, and uploadPaper', async () => {
      await paperController.ingestPaper('ws-1', 'u-1', { title: 'Paper' });
      expect(mockPaperService.ingestPaper).toHaveBeenCalledWith('ws-1', 'u-1', { title: 'Paper' });

      await paperController.getPapers('ws-1', 'col-1', 'search-term');
      expect(mockPaperService.getPapers).toHaveBeenCalledWith('ws-1', expect.objectContaining({ collectionId: 'col-1' }));

      await paperController.getWorkspaceTags('ws-1');
      expect(mockPaperService.getWorkspaceTags).toHaveBeenCalledWith('ws-1');

      await paperController.uploadPaper('ws-1', 'u-1', { title: 'P1', filename: 'p1.pdf', fileUrl: 'https://r2/p1.pdf' });
      expect(mockPaperService.uploadPaper).toHaveBeenCalledWith('ws-1', 'u-1', expect.any(Object));

      await paperController.triggerReindex('p-1', 'u-1');
      expect(mockPaperService.triggerReindex).toHaveBeenCalledWith('p-1', 'u-1');

      await paperController.deletePaper('p-1');
      expect(mockPaperService.deletePaper).toHaveBeenCalledWith('p-1');
    });
  });

  describe('2. CollectionController Endpoints', () => {
    it('should route getCollections, createCollection, movePapers, and exportCollectionBundle', async () => {
      await collectionController.getCollections('ws-1');
      expect(mockCollectionService.getCollections).toHaveBeenCalledWith('ws-1');

      await collectionController.createCollection('ws-1', 'u-1', { name: 'Deep Learning' });
      expect(mockCollectionService.createCollection).toHaveBeenCalledWith('ws-1', 'u-1', { name: 'Deep Learning' });

      await collectionController.movePapers('ws-1', 'col-1', { paperIds: ['p1'] });
      expect(mockCollectionService.movePapers).toHaveBeenCalledWith('ws-1', 'col-1', ['p1']);

      await collectionController.exportCollectionBundle('ws-1', 'col-1');
      expect(mockCollectionService.getCollectionExportBundle).toHaveBeenCalledWith('ws-1', 'col-1');
    });
  });

  describe('3. IngestionController Endpoints', () => {
    it('should route ingest, batchIngest, createAsyncBatchJob, and getJobStatus', async () => {
      await ingestionController.ingest('u-1', { workspaceId: 'ws-1', sourceType: IngestionSourceType.DOI, doi: '10.1000/182' });
      expect(mockIngestionService.ingest).toHaveBeenCalledWith('u-1', expect.any(Object));

      await ingestionController.batchIngest('u-1', { items: [] });
      expect(mockIngestionService.batchIngest).toHaveBeenCalledWith('u-1', { items: [] });

      await ingestionController.createAsyncBatchJob('u-1', { items: [] });
      expect(mockIngestionService.createAsyncBatchJob).toHaveBeenCalledWith('u-1', { items: [] });

      await ingestionController.getJobStatus('job-123');
      expect(mockIngestionService.getJobStatus).toHaveBeenCalledWith('job-123');
    });
  });

  describe('4. ReferenceController Endpoints', () => {
    it('should route formatPaperCitation, formatBatchCitations, resolve, importBibtex, exportRis', async () => {
      await referenceController.formatPaperCitation('ws-1', 'p-1', { style: 'apa' });
      expect(mockReferenceService.formatPaperCitation).toHaveBeenCalledWith('ws-1', 'p-1', 'apa');

      await referenceController.formatBatchCitations('ws-1', { paperIds: ['p1'], style: 'ieee' });
      expect(mockReferenceService.formatBatchCitations).toHaveBeenCalledWith('ws-1', expect.any(Object));

      await referenceController.resolve({ query: '10.1038/nature123' });
      expect(mockReferenceService.resolve).toHaveBeenCalledWith('10.1038/nature123');

      await referenceController.importBibtex('ws-1', 'u-1', { bibtex: '@article{}' });
      expect(mockReferenceService.importBibtex).toHaveBeenCalledWith('ws-1', 'u-1', { bibtex: '@article{}' });

      await referenceController.exportRis('ws-1', 'p-1');
      expect(mockReferenceService.exportRis).toHaveBeenCalledWith('ws-1', 'p-1');
    });
  });

  describe('5. AnnotationController Endpoints', () => {
    it('should route getAnnotations, createAnnotation, updateAnnotation, deleteAnnotation, extractNotes', async () => {
      await annotationController.getAnnotations('ws-1', 'p-1');
      expect(mockAnnotationService.getAnnotations).toHaveBeenCalledWith('ws-1', 'p-1');

      await annotationController.createAnnotation('ws-1', 'p-1', 'u-1', { type: 'highlight', pageNumber: 1, color: '#ff0' });
      expect(mockAnnotationService.createAnnotation).toHaveBeenCalledWith('ws-1', 'p-1', 'u-1', expect.any(Object));

      await annotationController.updateAnnotation('ws-1', 'p-1', 'ann-1', { color: '#00f' });
      expect(mockAnnotationService.updateAnnotation).toHaveBeenCalledWith('ws-1', 'p-1', 'ann-1', { color: '#00f' });

      await annotationController.deleteAnnotation('ws-1', 'p-1', 'ann-1');
      expect(mockAnnotationService.deleteAnnotation).toHaveBeenCalledWith('ws-1', 'p-1', 'ann-1');

      await annotationController.extractNotes('ws-1', 'p-1', 'u-1');
      expect(mockAnnotationService.extractNotesFromAnnotations).toHaveBeenCalledWith('ws-1', 'p-1', 'u-1');
    });
  });

  describe('6. RelationController Endpoints', () => {
    it('should route getRelatedPapers, linkPapers, unlinkPapers, getWorkspaceKnowledgeGraph', async () => {
      await relationController.getRelatedPapers('ws-1', 'p-1');
      expect(mockRelationService.getRelatedPapers).toHaveBeenCalledWith('ws-1', 'p-1');

      await relationController.linkPapers('ws-1', 'p-1', { targetPaperId: 'p-2', relationType: 'extends' });
      expect(mockRelationService.linkPapers).toHaveBeenCalledWith('ws-1', 'p-1', expect.any(Object));

      await relationController.unlinkPapers('ws-1', 'p-1', 'p-2');
      expect(mockRelationService.unlinkPapers).toHaveBeenCalledWith('ws-1', 'p-1', 'p-2');

      await relationController.getWorkspaceKnowledgeGraph('ws-1');
      expect(mockRelationService.getWorkspaceKnowledgeGraph).toHaveBeenCalledWith('ws-1');
    });
  });

  describe('7. QualityController Endpoints', () => {
    it('should route getDuplicateGroups, mergePapers, getIntegrityReport', async () => {
      await qualityController.getDuplicateGroups('ws-1');
      expect(mockQualityService.getDuplicateGroups).toHaveBeenCalledWith('ws-1');

      await qualityController.mergePapers('ws-1', 'u-1', { masterPaperId: 'p1', sourcePaperIds: ['p2'] });
      expect(mockQualityService.mergePapers).toHaveBeenCalledWith('ws-1', 'u-1', expect.any(Object));

      await qualityController.getIntegrityReport('ws-1');
      expect(mockQualityService.getIntegrityReport).toHaveBeenCalledWith('ws-1');
    });
  });

  describe('8. LibraryController (Unified Facade) Endpoint', () => {
    it('should route getPaperAcademicBundle', async () => {
      const bundle = await libraryController.getPaperAcademicBundle('ws-1', 'p-1');
      expect(mockLibraryService.getPaperAcademicBundle).toHaveBeenCalledWith('ws-1', 'p-1');
      expect(bundle.paper.id).toBe('p1');
    });
  });
});
