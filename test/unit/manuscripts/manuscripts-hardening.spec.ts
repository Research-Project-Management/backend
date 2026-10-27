import * as Y from 'yjs';
import { PkzipEngineAdapter } from '@/modules/manuscripts/export-import/services/pkzip-engine.adapter';
import { ManuscriptCleanupListener } from '@/modules/manuscripts/core/services/manuscript-cleanup.listener';
import { YjsUpdateValidator } from '@/modules/realtime/manuscripts/yjs-update-validator';
import { YjsService } from '@/modules/realtime/manuscripts/yjs.service';
import { RealtimeValidationFailedException } from '@/modules/realtime/core/ws-errors';
import { updateDocReviewStatusWithCas } from '@/modules/manuscripts/docstore/controllers/pages-review.helpers';
import { Role } from '@/modules/project/access';
import { ConflictException } from '@nestjs/common';

describe('PkzipEngineAdapter hardening', () => {
  const engine = new PkzipEngineAdapter();
  const build = () =>
    engine.buildZip([
      { path: 'main.tex', data: 'hello' },
      { path: 'refs.bib', data: '@article{a,}' },
    ]);
  const eocd = (zip: Buffer) => zip.length - 22;

  it('round-trips a valid archive', () => {
    const entries = engine.extractZip(build());
    expect(entries).toHaveLength(2);
  });

  it('rejects ZIP64 markers', () => {
    const zip = build();
    zip.writeUInt16LE(0xffff, eocd(zip) + 10);
    expect(() => engine.extractZip(zip)).toThrow(/ZIP64/);
  });

  it('rejects archives declaring more than MAX_PROJECT_ENTRY_COUNT entries', () => {
    const zip = build();
    zip.writeUInt16LE(10001, eocd(zip) + 10);
    expect(() => engine.extractZip(zip)).toThrow();
  });

  it('fails fast on a corrupted central directory instead of importing partially', () => {
    const zip = build();
    const cdOffset = zip.readUInt32LE(eocd(zip) + 16);
    zip.writeUInt32LE(0xdeadbeef, cdOffset);
    expect(() => engine.extractZip(zip)).toThrow(/central directory/i);
  });

  it('rejects buffers too small to be a ZIP', () => {
    expect(() => engine.extractZip(Buffer.alloc(5))).toThrow();
  });
});

describe('ManuscriptCleanupListener', () => {
  const tables = [
    'manuscriptTrackChange',
    'manuscriptCommentThread',
    'manuscriptNode',
    'manuscriptFile',
    'manuscriptSnapshot',
    'manuscriptNotification',
    'manuscriptCustomWord',
    'manuscriptDoc',
  ];
  const makePrisma = (txImpl?: () => Promise<unknown>) => {
    const prisma: Record<string, unknown> = {};
    for (const t of tables) {
      prisma[t] = { deleteMany: jest.fn().mockReturnValue(`op:${t}`) };
    }
    prisma.$transaction = jest.fn(txImpl ?? (async () => []));
    return prisma;
  };

  it('deletes every manuscript table for the project in one transaction', async () => {
    const prisma = makePrisma();
    const listener = new ManuscriptCleanupListener(prisma as never);
    await listener.handleProjectDeleted({ projectId: 'p1' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    for (const t of tables) {
      expect(
        (prisma[t] as { deleteMany: jest.Mock }).deleteMany,
      ).toHaveBeenCalledWith({ where: { projectId: 'p1' } });
    }
  });

  it('accepts entityId and ignores events without a project id', async () => {
    const prisma = makePrisma();
    const listener = new ManuscriptCleanupListener(prisma as never);
    await listener.handleProjectDeleted({ entityId: 'p2' });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    await listener.handleProjectDeleted({});
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('does not rethrow when cleanup fails', async () => {
    const prisma = makePrisma(async () => {
      throw new Error('db down');
    });
    const listener = new ManuscriptCleanupListener(prisma as never);
    await expect(
      listener.handleProjectDeleted({ projectId: 'p3' }),
    ).resolves.toBeUndefined();
  });
});

describe('YjsUpdateValidator.validatePreApplySize', () => {
  const validator = new YjsUpdateValidator();
  const docWith = (text: string) => {
    const doc = new Y.Doc();
    doc.getText('latex').insert(0, text);
    return doc;
  };

  it('accepts an update that stays within the limit', () => {
    expect(() =>
      validator.validatePreApplySize(docWith('abc'), 10, 1000),
    ).not.toThrow();
  });

  it('rejects at the boundary: chars*4 + incoming > max', () => {
    const doc = docWith('a'.repeat(100)); // 400 bytes approx
    expect(() => validator.validatePreApplySize(doc, 600, 1000)).not.toThrow();
    expect(() => validator.validatePreApplySize(doc, 601, 1000)).toThrow(
      RealtimeValidationFailedException,
    );
  });

  it('does not mutate the document', () => {
    const doc = docWith('keep');
    try {
      validator.validatePreApplySize(doc, 1_000_000, 100);
    } catch {
      // expected
    }
    expect(doc.getText('latex').toString()).toBe('keep');
  });
});

describe('YjsService Cluster Relay & Distributed Flush Lock', () => {
  const projId = '01950000-0000-7000-8000-000000000001';
  const docId = '01950000-0000-7000-8000-000000000002';

  it('applies peer yjs-update and external-text cluster relay messages and ignores self-origin', async () => {
    const serviceA = new YjsService();
    const serviceB = new YjsService();
    const sessionA = await serviceA.getOrCreateDoc(projId, docId);
    const sessionB = await serviceB.getOrCreateDoc(projId, docId);

    sessionA.doc.transact(() => {
      sessionA.yText.insert(0, 'Hello Cluster');
    });
    const updateBytes = Y.encodeStateAsUpdate(sessionA.doc);

    // Self-origin should be ignored
    serviceB.handleClusterRelayMessage({
      instanceId: serviceB.instanceId,
      type: 'yjs-update',
      projectId: projId,
      docId,
      updateBase64: Buffer.from(updateBytes).toString('base64'),
    });
    expect(sessionB.yText.toString()).toBe('');

    // Peer origin should apply
    serviceB.handleClusterRelayMessage({
      instanceId: serviceA.instanceId,
      type: 'yjs-update',
      projectId: projId,
      docId,
      updateBase64: Buffer.from(updateBytes).toString('base64'),
    });
    expect(sessionB.yText.toString()).toBe('Hello Cluster');

    // External text relay
    serviceB.handleClusterRelayMessage({
      instanceId: serviceA.instanceId,
      type: 'external-text',
      projectId: projId,
      docId,
      text: 'Replaced by REST',
    });
    expect(sessionB.yText.toString()).toBe('Replaced by REST');

    await serviceA.onModuleDestroy();
    await serviceB.onModuleDestroy();
  });

  it('skips docstore flush when distributed Redis lock is held by another node', async () => {
    const mockClient = {
      set: jest.fn().mockResolvedValue(null), // NX lock failed
      get: jest.fn(),
      del: jest.fn(),
    };
    const mockRedis = {
      isReady: () => true,
      getClient: () => mockClient,
      getBuffer: jest.fn().mockResolvedValue(null),
      setBuffer: jest.fn().mockResolvedValue(undefined),
    };
    const mockDocstore = {
      getDoc: jest.fn().mockResolvedValue({ lines: ['init'], rev: 1, version: 1 }),
      updateDoc: jest.fn(),
    };
    const service = new YjsService(mockRedis as never, mockDocstore as never);
    const session = await service.getOrCreateDoc(projId, docId);
    session.yText.insert(4, ' edit');

    await service.flushDoc(projId, docId);
    expect(mockDocstore.updateDoc).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });
});

describe('Review Status CAS Concurrency Protection', () => {
  const projId = '01950000-0000-7000-8000-000000000001';
  const docId = '01950000-0000-7000-8000-000000000002';

  it('throws ConflictException when concurrent version update fails CAS check', async () => {
    const mockPrisma = {
      manuscriptDocReview: {
        findUnique: jest.fn().mockResolvedValue({
          docId,
          projectId: projId,
          status: 'draft',
          roundNumber: 1,
          version: 3,
          requestedById: null,
          requestedAt: null,
          verdictById: null,
          verdictAt: null,
          notes: null,
          deadline: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    const mockDocstore = {
      getDoc: jest.fn().mockResolvedValue({ id: docId, projectId: projId, ranges: {} }),
      patchDoc: jest.fn(),
    };

    await expect(
      updateDocReviewStatusWithCas({
        prisma: mockPrisma as never,
        docstoreService: mockDocstore as never,
        projectId: projId,
        docId,
        body: { status: 'in_review' },
        currentRole: Role.OWNER,
      }),
    ).rejects.toThrow(ConflictException);
    expect(mockDocstore.patchDoc).not.toHaveBeenCalled();
  });
});
