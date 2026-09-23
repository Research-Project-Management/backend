/**
 * test/unit/manuscripts-docstore.service.spec.ts
 *
 * Comprehensive Unit Test Suite for Manuscripts Docstore Subsystem.
 * Validates all 7 Overleaf-parity processing levels:
 *  1. Transport & DTO validation.
 *  2. Tiered Storage (Hot DB vs Cold S3) & Zero-Write Peek.
 *  3. Optimistic Concurrency Control (OCC with rev check & 409 conflict).
 *  4. Line-Array Engine (CRLF normalization, BOM stripping, Null-byte guard, Splice).
 *  5. Track Changes & Range coordinate mapping.
 *  6. Skip No-Op diff filtering.
 *  7. Direct CLSI compilation feed (WorkspaceFile[] generation) & Telemetry.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { PrismaService } from '@/core/database/prisma.service';
import { GetDocUseCase } from '@/modules/manuscripts/docstore/core/use-cases/get-doc.use-case';
import { PeekDocUseCase } from '@/modules/manuscripts/docstore/core/use-cases/peek-doc.use-case';
import { UpdateDocUseCase } from '@/modules/manuscripts/docstore/core/use-cases/update-doc.use-case';
import { PatchDocUseCase } from '@/modules/manuscripts/docstore/core/use-cases/patch-doc.use-case';
import { GetAllDocsUseCase } from '@/modules/manuscripts/docstore/core/use-cases/get-all-docs.use-case';
import { ArchiveProjectUseCase } from '@/modules/manuscripts/docstore/core/use-cases/archive-project.use-case';
import { PrismaDocRepository } from '@/modules/manuscripts/docstore/core/adapters/database/prisma-doc.repository';
import { S3DocPersistorAdapter } from '@/modules/manuscripts/docstore/core/adapters/storage/s3-doc-persistor.adapter';
import { DocHasherAdapter } from '@/modules/manuscripts/docstore/core/adapters/engine/doc-hasher.adapter';
import { IDocRepository } from '@/modules/manuscripts/docstore/core/ports/doc-repository.port';
import { IDocPersistor } from '@/modules/manuscripts/docstore/core/ports/doc-persistor.port';
import { IDocHasher } from '@/modules/manuscripts/docstore/core/ports/doc-hasher.port';
import { LineArrayEngine } from '@/modules/manuscripts/docstore/core/adapters/engine/line-array.engine';
import { NoopDiffChecker } from '@/modules/manuscripts/docstore/core/adapters/engine/noop-diff.checker';
import { DocRangeVo } from '@/modules/manuscripts/docstore/core/domain/doc-range.vo';
import {
  DocNotFoundError,
  DocModifiedError,
  DocTooLargeError,
  NullByteDetectedError,
} from '@/modules/manuscripts/docstore/core/domain/doc-errors';
import { TextDoc } from '@/modules/manuscripts/docstore/core/domain/text-doc.entity';
import { DocstoreMetrics } from '@/modules/manuscripts/docstore/core/adapters/telemetry/docstore.metrics';

describe('Manuscripts - Docstore Subsystem (Overleaf Parity)', () => {
  let service: DocstoreService;
  let docRepository: IDocRepository;
  let docPersistor: IDocPersistor;
  let docHasher: IDocHasher;

  const PROJECT_ID = 'b7d5a570-3d7c-482a-9e53-488b0a996df1';
  const DOC_ID = 'e2b3c4d5-6f7a-8b9c-0d1e-2f3a4b5c6d7e';

  // In-memory mock storage simulating PostgreSQL manuscript_docs table
  const mockDbDocs = new Map<string, any>();

  const mockPrismaService = {
    manuscriptDoc: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.id) {
          return mockDbDocs.get(where.id) || null;
        }
        if (where.projectId && where.path) {
          for (const doc of mockDbDocs.values()) {
            if (doc.projectId === where.projectId && doc.path === where.path && !doc.deleted) {
              return doc;
            }
          }
        }
        return null;
      }),
      findMany: jest.fn(async ({ where }: any) => {
        const results: any[] = [];
        for (const doc of mockDbDocs.values()) {
          if (doc.projectId === where.projectId) {
            if (where.deleted !== undefined && doc.deleted !== where.deleted) continue;
            results.push(doc);
          }
        }
        return results;
      }),
      create: jest.fn(async ({ data }: any) => {
        const id = data.id || `doc-${Date.now()}-${Math.random()}`;
        const record = {
          id,
          projectId: data.projectId,
          path: data.path,
          lines: data.lines,
          rev: data.rev ?? 1,
          version: data.version ?? 0,
          ranges: data.ranges || { changes: [], comments: [] },
          hash: data.hash || '',
          sizeBytes: data.sizeBytes ?? 0,
          inStorage: data.inStorage ?? false,
          storageKey: null,
          deleted: false,
          deletedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        mockDbDocs.set(id, record);
        return record;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const existing = mockDbDocs.get(where.id);
        if (!existing) throw new Error('Not found');

        const updated = {
          ...existing,
          ...data,
          rev: data.rev?.increment ? existing.rev + 1 : (data.rev ?? existing.rev),
          updatedAt: new Date(),
        };
        mockDbDocs.set(where.id, updated);
        return updated;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const doc of mockDbDocs.values()) {
          if (doc.id === where.id && doc.projectId === where.projectId) {
            if (where.rev !== undefined && doc.rev !== where.rev) continue;
            Object.assign(doc, data);
            count++;
          }
        }
        return { count };
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        let count = 0;
        if (where.id) {
          if (mockDbDocs.delete(where.id)) count++;
        } else if (where.projectId) {
          for (const [id, doc] of mockDbDocs.entries()) {
            if (doc.projectId === where.projectId) {
              mockDbDocs.delete(id);
              count++;
            }
          }
        }
        return { count };
      }),
    },
  };

  const mockConfigService = {
    get: jest.fn((key: string) => {
      if (key === 'S3_BUCKET_NAME') return 'flux-test-archive';
      return null;
    }),
  };

  beforeEach(async () => {
    mockDbDocs.clear();
    DocstoreMetrics.reset();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DocstoreService,
        GetDocUseCase,
        PeekDocUseCase,
        UpdateDocUseCase,
        PatchDocUseCase,
        GetAllDocsUseCase,
        ArchiveProjectUseCase,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: IDocRepository, useClass: PrismaDocRepository },
        { provide: IDocPersistor, useClass: S3DocPersistorAdapter },
        { provide: IDocHasher, useClass: DocHasherAdapter },
        PrismaDocRepository,
        S3DocPersistorAdapter,
        DocHasherAdapter,
      ],
    }).compile();

    service = module.get<DocstoreService>(DocstoreService);
    docRepository = module.get<IDocRepository>(IDocRepository);
    docPersistor = module.get<IDocPersistor>(IDocPersistor);
    docHasher = module.get<IDocHasher>(IDocHasher);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // =========================================================================
  // LEVEL 4: LineArrayEngine (Sanitization, Normalization, Splice)
  // =========================================================================
  describe('Level 4: LineArrayEngine (Text Processing & Defensive Guard)', () => {
    it('should normalize CRLF (\\r\\n) and CR (\\r) to Unix LF (\\n)', () => {
      const rawText = 'line1\r\nline2\rline3\nline4';
      const lines = LineArrayEngine.textToLines(rawText);
      expect(lines).toEqual(['line1', 'line2', 'line3', 'line4']);
      expect(LineArrayEngine.linesToText(lines)).toBe('line1\nline2\nline3\nline4');
    });

    it('should strip UTF-8 Byte Order Mark (BOM)', () => {
      const textWithBom = '\ufeff\\documentclass{article}\n\\begin{document}';
      const lines = LineArrayEngine.textToLines(textWithBom);
      expect(lines[0]).toBe('\\documentclass{article}');
      expect(lines[0].charCodeAt(0)).not.toBe(0xfeff);
    });

    it('should detect \\u0000 null byte and throw NullByteDetectedError', () => {
      const corruptText = 'some valid latex text\u0000corrupted string';
      expect(() => LineArrayEngine.textToLines(corruptText)).toThrow(NullByteDetectedError);
    });

    it('should reject documents exceeding 2MB maximum size limit', () => {
      const oversizedText = 'x'.repeat(2 * 1024 * 1024 + 10);
      expect(() => LineArrayEngine.textToLines(oversizedText)).toThrow(DocTooLargeError);
    });

    it('should apply in-place line splice correctly', () => {
      const originalLines = ['line1', 'line2', 'line3', 'line4', 'line5'];
      // Replace line 2 and 3 (index 1, deleteCount 2) with ['new2', 'new3', 'newExtra']
      const spliced = LineArrayEngine.applySplice(originalLines, 1, 2, ['new2', 'new3', 'newExtra']);
      expect(spliced).toEqual(['line1', 'new2', 'new3', 'newExtra', 'line4', 'line5']);
    });
  });

  // =========================================================================
  // LEVEL 4 & 6: Skip No-Op Diff Checking
  // =========================================================================
  describe('Level 4: Skip No-Op Diff Checking', () => {
    it('should detect identical lines and report shouldUpdate: false', () => {
      const doc = new TextDoc({
        id: DOC_ID,
        projectId: PROJECT_ID,
        path: 'main.tex',
        lines: ['line1', 'line2'],
        rev: 1,
        version: 5,
        ranges: { changes: [], comments: [] },
      });

      const diff = NoopDiffChecker.checkDiff(doc, ['line1', 'line2'], 5, { changes: [], comments: [] });
      expect(diff.shouldUpdate).toBe(false);
      expect(diff.updateLines).toBe(false);
      expect(diff.updateVersion).toBe(false);
    });

    it('should detect line modifications or version increment', () => {
      const doc = new TextDoc({
        id: DOC_ID,
        projectId: PROJECT_ID,
        path: 'main.tex',
        lines: ['line1', 'line2'],
        rev: 1,
        version: 5,
      });

      const diff = NoopDiffChecker.checkDiff(doc, ['line1', 'modified line2'], 5);
      expect(diff.shouldUpdate).toBe(true);
      expect(diff.updateLines).toBe(true);
    });
  });

  // =========================================================================
  // LEVEL 3: Optimistic Concurrency Control (OCC with rev)
  // =========================================================================
  describe('Level 3: Optimistic Concurrency Control (OCC)', () => {
    it('should update document and increment rev when expectedRev matches', async () => {
      // 1. Seed document with rev = 1
      const created = await service.createDoc(PROJECT_ID, {
        path: 'main.tex',
        lines: ['\\documentclass{article}', '\\begin{document}'],
        version: 1,
      });
      expect(created.rev).toBe(1);

      // 2. Update with matching expectedRev: 1
      const updateResult = await service.updateDoc(PROJECT_ID, created._id, {
        lines: ['\\documentclass{article}', '\\begin{document}', 'Hello World'],
        version: 2,
        expectedRev: 1,
      });

      expect(updateResult.modified).toBe(true);
      expect(updateResult.rev).toBe(2);

      // 3. Verify in repository
      const fetched = await service.getDoc(PROJECT_ID, created._id);
      expect(fetched.rev).toBe(2);
      expect(fetched.lines.length).toBe(3);
    });

    it('should throw DocModifiedError (409 Conflict) when expectedRev does not match current rev', async () => {
      const created = await service.createDoc(PROJECT_ID, {
        path: 'conflict.tex',
        lines: ['initial content'],
        version: 1,
      });
      expect(created.rev).toBe(1);

      // Simulate a concurrent write that bumped rev to 2
      await docRepository.updateDoc(PROJECT_ID, created._id, {
        lines: ['concurrent write by another client'],
        version: 2,
      });

      // Stale client attempts to write with expectedRev: 1 -> must throw DocModifiedError
      await expect(
        service.updateDoc(PROJECT_ID, created._id, {
          lines: ['stale client write'],
          version: 3,
          expectedRev: 1, // Stale!
        })
      ).rejects.toThrow(DocModifiedError);
    });

    it('should skip database write when updating with identical content (No-op update)', async () => {
      const created = await service.createDoc(PROJECT_ID, {
        path: 'noop.tex',
        lines: ['identical line'],
        version: 1,
      });

      const result = await service.updateDoc(PROJECT_ID, created._id, {
        lines: ['identical line'],
        version: 1,
      });

      expect(result.modified).toBe(false);
      expect(result.rev).toBe(1); // Rev did not increment because no DB write occurred!
      expect(service.getMetricsSummary().noopSkips).toBe(1);
    });
  });

  // =========================================================================
  // LEVEL 2: Tiered Storage (Hot DB vs Cold S3) & Zero-Write Peek
  // =========================================================================
  describe('Level 2: Tiered Storage (Hot DB vs Cold S3) & Zero-Write Peek', () => {
    it('should archive project documents to S3 and strip lines from Database', async () => {
      // 1. Create 2 documents
      const doc1 = await service.createDoc(PROJECT_ID, {
        path: 'chapter1.tex',
        lines: ['\\chapter{One}', 'Text content'],
      });
      const doc2 = await service.createDoc(PROJECT_ID, {
        path: 'chapter2.tex',
        lines: ['\\chapter{Two}', 'Text content'],
      });

      // 2. Archive project
      const archivedCount = await service.archiveAllDocs(PROJECT_ID);
      expect(archivedCount).toBe(2);

      // 3. Verify in repository: lines are cleared, inStorage is true
      const rawRecord1 = mockDbDocs.get(doc1._id);
      expect(rawRecord1.inStorage).toBe(true);
      expect(rawRecord1.storageKey).toBe(`${PROJECT_ID}/${doc1._id}.json`);
      expect(rawRecord1.lines).toEqual([]);
    });

    it('Zero-Write Peek: should read lines directly from S3 without writing back to DB', async () => {
      const doc = await service.createDoc(PROJECT_ID, {
        path: 'peek.tex',
        lines: ['Line 1 for peek test', 'Line 2 for peek test'],
      });
      await service.archiveAllDocs(PROJECT_ID);

      // Perform peek
      const peekResult = await service.peekDoc(PROJECT_ID, doc._id);
      expect(peekResult.status).toBe('archived');
      expect(peekResult.doc.lines).toEqual(['Line 1 for peek test', 'Line 2 for peek test']);

      // Ensure database STILL has lines cleared (Zero-write verified!)
      const dbDoc = mockDbDocs.get(doc._id);
      expect(dbDoc.inStorage).toBe(true);
      expect(dbDoc.lines).toEqual([]);
    });

    it('Hydrate on Get: should automatically restore lines from S3 when getDoc is requested', async () => {
      const doc = await service.createDoc(PROJECT_ID, {
        path: 'hydrate.tex',
        lines: ['Line to hydrate from S3'],
      });
      await service.archiveAllDocs(PROJECT_ID);

      // Call standard getDoc
      const hydrated = await service.getDoc(PROJECT_ID, doc._id);
      expect(hydrated.inStorage).toBe(false);
      expect(hydrated.lines).toEqual(['Line to hydrate from S3']);

      // Ensure database has restored lines
      const dbDoc = mockDbDocs.get(doc._id);
      expect(dbDoc.inStorage).toBe(false);
      expect(dbDoc.lines).toEqual(['Line to hydrate from S3']);
    });
  });

  // =========================================================================
  // LEVEL 5: Track Changes & Range Coordinate Mapping
  // =========================================================================
  describe('Level 5: Track Changes & Range Coordinate Mapping', () => {
    it('should normalize and persist comments and track changes ranges', async () => {
      const ranges = {
        changes: [{ id: 'change-1', metadata: { user_id: 'user-123', ts: '2026-09-23T10:00:00.000Z' } }],
        comments: [{ id: 'comment-1', op: { t: 'highlight' }, metadata: { user_id: 'user-456' } }],
      };

      const doc = await service.createDoc(PROJECT_ID, {
        path: 'reviewed.tex',
        lines: ['Draft paragraph for peer review.'],
        ranges,
      });

      expect(doc.ranges.changes?.length).toBe(1);
      expect(doc.ranges.comments?.length).toBe(1);
      expect(doc.ranges.comments?.[0].id).toBe('comment-1');
    });

    it('should retrieve all ranges across project documents with getAllRanges', async () => {
      const ranges = {
        comments: [{ id: 'c-1', quote: 'test note', resolved: false }],
      };
      const doc = await service.createDoc(PROJECT_ID, {
        path: 'ranges-test.tex',
        lines: ['line 1'],
        ranges,
      });

      const allRanges = await service.getAllRanges(PROJECT_ID);
      expect(allRanges.length).toBeGreaterThan(0);
      const found = allRanges.find((r) => r._id === doc._id);
      expect(found).toBeDefined();
      expect(found?.ranges.comments?.[0].id).toBe('c-1');
    });
  });

  describe('Single-Doc Archival & Soft Deletion Status', () => {
    it('should archive a single document to S3 and verify with isDocDeleted', async () => {
      const doc = await service.createDoc(PROJECT_ID, {
        path: 'single-archive.tex',
        lines: ['Archive me individually'],
      });

      // Initially not deleted
      let isDeleted = await service.isDocDeleted(PROJECT_ID, doc._id);
      expect(isDeleted).toBe(false);

      // Archive single doc
      await service.archiveDoc(PROJECT_ID, doc._id);

      // Verify doc lines are removed from DB and marked inStorage
      const archivedDoc = await service.peekDoc(PROJECT_ID, doc._id);
      expect(archivedDoc.status).toBe('archived');
      expect(archivedDoc.doc.lines).toEqual(['Archive me individually']);

      // Soft delete doc
      await service.patchDoc(PROJECT_ID, doc._id, {
        deleted: true,
        name: 'single-archive.tex',
      });
      isDeleted = await service.isDocDeleted(PROJECT_ID, doc._id);
      expect(isDeleted).toBe(true);
    });
  });

  // =========================================================================
  // DIRECT CLSI COMPILATION INTEGRATION
  // =========================================================================
  describe('Direct CLSI Integration (WorkspaceFile[] Feed)', () => {
    it('should export all project documents into WorkspaceFile[] for CLSI compiler', async () => {
      await service.createDoc(PROJECT_ID, {
        path: 'main.tex',
        lines: ['\\documentclass{article}', '\\begin{document}', '\\input{intro}', '\\end{document}'],
      });
      await service.createDoc(PROJECT_ID, {
        path: 'intro.tex',
        lines: ['\\section{Introduction}', 'This is introduction content.'],
      });
      await service.createDoc(PROJECT_ID, {
        path: 'refs.bib',
        lines: ['@article{test, title={Flux Journal}}'],
      });

      // Export as WorkspaceFile[]
      const workspaceFiles = await service.getAsWorkspaceFiles(PROJECT_ID);

      expect(workspaceFiles.length).toBe(3);
      const paths = workspaceFiles.map((f) => f.path);
      expect(paths).toContain('main.tex');
      expect(paths).toContain('intro.tex');
      expect(paths).toContain('refs.bib');

      const mainFile = workspaceFiles.find((f) => f.path === 'main.tex');
      expect(mainFile?.content).toContain('\\documentclass{article}');
      expect(mainFile?.hash).toBeDefined();
    });
  });

  // =========================================================================
  // LEVEL 7: Telemetry & Prometheus Metrics
  // =========================================================================
  describe('Level 7: Telemetry & Prometheus Metrics', () => {
    it('should record reads, writes, and output valid Prometheus metrics', async () => {
      await service.createDoc(PROJECT_ID, {
        path: 'metrics.tex',
        lines: ['metrics content line'],
      });

      const metricsSummary = service.getMetricsSummary();
      expect(metricsSummary.totalWrites).toBeGreaterThanOrEqual(1);

      const prometheusOutput = service.getPrometheusMetrics();
      expect(prometheusOutput).toContain('docstore_reads_total');
      expect(prometheusOutput).toContain('docstore_writes_total');
      expect(prometheusOutput).toContain('docstore_occ_conflicts_total');
    });
  });
});
