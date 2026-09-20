import {
  LocalEmbeddingService,
  EMBEDDING_DIMENSIONS,
} from '../../src/modules/library/discovery/application/services/local-embedding.service';
import { VectorIndexService } from '../../src/modules/library/discovery/application/services/vector-index.service';
import { SemanticSearchService } from '../../src/modules/library/discovery/application/services/semantic-search.service';

describe('In-Process Local Embeddings & Semantic Vector Search', () => {
  let embeddingService: LocalEmbeddingService;
  let vectorIndex: VectorIndexService;
  let semanticSearch: SemanticSearchService;
  let mockPrisma: any;

  const mockPapers = [
    {
      id: 'paper-pinn-1',
      title:
        'Physics-informed neural networks for solving partial differential equations',
      abstract:
        'We introduce physics-informed neural networks (PINNs) which are trained to solve supervised learning tasks while respecting physical laws described by nonlinear partial differential equations.',
      year: 2019,
      doi: '10.1016/j.jcp.2018.10.045',
      itemType: 'journalArticle',
      publicationTitle: 'Journal of Computational Physics',
      userId: 'user-1',
      deletedAt: null,
      contributors: [
        { fullName: 'Maziar Raissi', orderIndex: 0 },
        { fullName: 'Paris Perdikaris', orderIndex: 1 },
      ],
    },
    {
      id: 'paper-transformer-2',
      title: 'Attention is all you need',
      abstract:
        'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks. We propose a new simple network architecture, the Transformer, based solely on attention mechanisms.',
      year: 2017,
      doi: '10.48550/arXiv.1706.03762',
      itemType: 'preprint',
      publicationTitle: 'NeurIPS',
      userId: 'user-1',
      deletedAt: null,
      contributors: [
        { fullName: 'Ashish Vaswani', orderIndex: 0 },
        { fullName: 'Noam Shazeer', orderIndex: 1 },
      ],
    },
    {
      id: 'paper-covid-3',
      title: 'Clinical characteristics of coronavirus disease 2019 in China',
      abstract:
        'During the initial outbreak of COVID-19, coronavirus spread rapidly. We analyzed clinical data from 1099 patients with laboratory-confirmed Covid-19 from 552 hospitals in 30 provinces.',
      year: 2020,
      doi: '10.1056/NEJMoa2002032',
      itemType: 'journalArticle',
      publicationTitle: 'New England Journal of Medicine',
      userId: 'user-1',
      deletedAt: null,
      contributors: [
        { fullName: 'Wei-jie Guan', orderIndex: 0 },
        { fullName: 'Zheng-yi Ni', orderIndex: 1 },
      ],
    },
  ];

  beforeEach(() => {
    embeddingService = new LocalEmbeddingService();

    const vectorDb = new Map<string, any>();
    mockPrisma = {
      metadataSourceRecord: {
        findFirst: jest.fn(async ({ where }: any) => {
          return vectorDb.get(where.itemId) || null;
        }),
        findMany: jest.fn(async ({ where }: any) => {
          const ids = where?.itemId?.in || [];
          const list: any[] = [];
          for (const id of ids) {
            if (vectorDb.has(id)) list.push(vectorDb.get(id));
          }
          return list;
        }),
        create: jest.fn(async ({ data }: any) => {
          vectorDb.set(data.itemId, { ...data, id: `msr-${data.itemId}` });
          return vectorDb.get(data.itemId);
        }),
        update: jest.fn(async ({ where, data }: any) => {
          // Find by id
          for (const [key, val] of vectorDb.entries()) {
            if (val.id === where.id) {
              const updated = { ...val, ...data };
              vectorDb.set(key, updated);
              return updated;
            }
          }
          return null;
        }),
      },
      item: {
        findMany: jest.fn(async ({ where }: any) => {
          let list = mockPapers.filter((p) => p.userId === where.userId);
          if (where?.id?.not) {
            list = list.filter((p) => p.id !== where.id.not);
          }
          return list;
        }),
        findFirst: jest.fn(async ({ where }: any) => {
          return mockPapers.find((p) => p.id === where.id) || null;
        }),
      },
    };

    vectorIndex = new VectorIndexService(mockPrisma, embeddingService);
    semanticSearch = new SemanticSearchService(
      mockPrisma,
      embeddingService,
      vectorIndex,
    );
  });

  describe('LocalEmbeddingService', () => {
    it('should generate a 384-dimensional dense vector normalized to unit length', async () => {
      const vec = await embeddingService.embedText(
        'Physics-informed neural networks for computational fluid dynamics',
      );

      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(EMBEDDING_DIMENSIONS);

      // Verify L2 unit norm: sqrt(sum(v_i^2)) ≈ 1.0
      let sumSq = 0;
      for (let i = 0; i < vec.length; i++) sumSq += vec[i] * vec[i];
      expect(Math.sqrt(sumSq)).toBeCloseTo(1.0, 3);
    });

    it('should compute cosine similarity = 1.0 for identical text', async () => {
      const text = 'Attention is all you need for transformer architectures';
      const vec1 = await embeddingService.embedText(text);
      const vec2 = await embeddingService.embedText(text);

      const sim = embeddingService.cosineSimilarity(vec1, vec2);
      expect(sim).toBeCloseTo(1.0, 4);
    });

    it('should produce higher similarity for related topics than unrelated topics', async () => {
      const queryVec = await embeddingService.embedText(
        'transformer attention mechanism in deep learning',
      );
      const relatedVec = await embeddingService.embedText(
        'simple network architecture based solely on attention mechanisms',
      );
      const unrelatedVec = await embeddingService.embedText(
        'clinical patients admitted with respiratory viral pandemic',
      );

      const simRelated = embeddingService.cosineSimilarity(
        queryVec,
        relatedVec,
      );
      const simUnrelated = embeddingService.cosineSimilarity(
        queryVec,
        unrelatedVec,
      );

      expect(simRelated).toBeGreaterThan(simUnrelated);
      expect(simRelated).toBeGreaterThan(0.3);
    });
  });

  describe('VectorIndexService', () => {
    it('should save and retrieve item vector from in-memory cache and DB', async () => {
      const vec = await embeddingService.embedText('Test paper title');
      await vectorIndex.saveVector('item-1', vec, 'test-model');

      expect(vectorIndex.indexSize).toBe(1);

      const retrieved = await vectorIndex.getVector('item-1');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.length).toBe(EMBEDDING_DIMENSIONS);
      expect(retrieved![0]).toBeCloseTo(vec[0], 5);
    });

    it('should rank similar items based on cosine similarity', async () => {
      const vecA = await embeddingService.embedText(
        'quantum computing algorithms',
      );
      const vecB = await embeddingService.embedText(
        'quantum circuits and qubits optimization',
      );
      const vecC = await embeddingService.embedText(
        'botany photosynthesis in tropical plants',
      );

      await vectorIndex.saveVector('item-a', vecA);
      await vectorIndex.saveVector('item-b', vecB);
      await vectorIndex.saveVector('item-c', vecC);

      const matches = await vectorIndex.searchSimilar(
        vecA,
        ['item-a', 'item-b', 'item-c'],
        10,
        0.1,
      );

      expect(matches.length).toBeGreaterThanOrEqual(2);
      expect(matches[0].itemId).toBe('item-a'); // Exact match first
      expect(matches[0].similarityScore).toBeCloseTo(1.0, 4);
      expect(matches[1].itemId).toBe('item-b'); // Related quantum paper second
    });
  });

  describe('SemanticSearchService', () => {
    beforeEach(async () => {
      // Pre-index mock papers into vector store
      for (const paper of mockPapers) {
        await semanticSearch.indexItem(paper);
      }
    });

    it('should perform semantic search and return relevant ranked papers', async () => {
      const res = await semanticSearch.searchSemantic('user-1', {
        query:
          'solving differential equations with neural networks and physics',
        limit: 5,
        threshold: 0.2,
      });

      expect(res.results.length).toBeGreaterThan(0);
      // PINN paper should be the top match
      expect(res.results[0].id).toBe('paper-pinn-1');
      expect(res.results[0].similarityScore).toBeGreaterThan(0.3);
      expect(res.results[0].authors).toContain('Maziar Raissi');
    });

    it('should find related papers ("More like this")', async () => {
      // Add a second machine learning paper to find as related to transformer
      const relatedPaper = {
        id: 'paper-bert-4',
        title:
          'BERT: Pre-training of deep bidirectional transformers for language understanding',
        abstract:
          'We introduce a new language representation model called BERT which stands for Bidirectional Encoder Representations from Transformers.',
        year: 2019,
        doi: '10.48550/arXiv.1810.04805',
        itemType: 'preprint',
        publicationTitle: 'NAACL',
        userId: 'user-1',
        deletedAt: null,
        contributors: [{ fullName: 'Jacob Devlin', orderIndex: 0 }],
      };
      mockPapers.push(relatedPaper);
      await semanticSearch.indexItem(relatedPaper);

      const related = await semanticSearch.findRelatedItems(
        'user-1',
        'paper-transformer-2',
        3,
      );

      expect(related.length).toBeGreaterThan(0);
      // BERT should be the most related paper to Transformer
      expect(related[0].id).toBe('paper-bert-4');
      expect(related[0].similarityScore).toBeGreaterThan(0.2);
    });

    it('should batch index entire library', async () => {
      const stats = await semanticSearch.indexLibrary('user-1');
      expect(stats.total).toBeGreaterThanOrEqual(3);
      expect(stats.indexed).toBeGreaterThanOrEqual(3);
    });
  });
});
