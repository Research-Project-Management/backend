import { buildClonePlan } from '@/modules/pages/page/services/duplicate.service';

describe('buildClonePlan (Prototype Batch Cloner)', () => {
  const spaceId = '11111111-1111-4111-8111-111111111111';
  const newPageId = '22222222-2222-4222-8222-222222222222';

  function makeDeterministicIdGen() {
    let seq = 1;
    return () => `gen-id-${seq++}`;
  }

  it('maps root doc to newPageId, preserves hydrated lines, and updates only root ranges.title', () => {
    const plan = buildClonePlan({
      spaceId,
      newPageId,
      newPageTitle: 'Paper (Copy)',
      sourceRootDocId: 'doc-root',
      sourceDocs: [
        {
          id: 'doc-root',
          lastKnownPath: 'main.tex',
          lines: ['stale'],
          ranges: { title: 'Paper', status: 'draft' },
          hash: 'h1',
          sizeBytes: 12,
        },
        {
          id: 'doc-sec',
          lastKnownPath: 'sections/intro.tex',
          lines: ['\\section{Intro}'],
          ranges: { custom: true },
          hash: 'h2',
          sizeBytes: 15,
        },
      ],
      hydratedDocLinesById: new Map([
        ['doc-root', ['\\documentclass{article}', '\\begin{document}']],
      ]),
      sourceFiles: [],
      sourceNodes: [],
      generateId: makeDeterministicIdGen(),
    });

    expect(plan.clonedRootDocId).toBe(newPageId);
    expect(plan.docsToCreate).toHaveLength(2);

    const [rootDoc, childDoc] = plan.docsToCreate;
    expect(rootDoc.id).toBe(newPageId);
    expect(rootDoc.pageId).toBe(newPageId);
    expect(rootDoc.lines).toEqual([
      '\\documentclass{article}',
      '\\begin{document}',
    ]);
    expect(rootDoc.ranges).toEqual({ title: 'Paper (Copy)', status: 'draft' });
    expect(rootDoc.inStorage).toBe(false);

    expect(childDoc.id).toBe('gen-id-1');
    expect(childDoc.lines).toEqual(['\\section{Intro}']);
    expect(childDoc.ranges).toEqual({ custom: true });
  });

  it('groups PageNodes by BFS depth even when input is unsorted and remaps parentId/docId/fileId', () => {
    const plan = buildClonePlan({
      spaceId,
      newPageId,
      newPageTitle: 'Cloned',
      sourceRootDocId: 'doc-1',
      sourceDocs: [
        {
          id: 'doc-1',
          lastKnownPath: 'main.tex',
          lines: ['hello'],
          ranges: {},
          hash: 'h1',
          sizeBytes: 5,
        },
      ],
      hydratedDocLinesById: new Map(),
      sourceFiles: [
        {
          id: 'file-1',
          blobId: 'blob-a',
          lastKnownPath: 'images/fig1.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
          hash: 'fh1',
          storageKey: 'k1',
          bucketName: 'b1',
        },
      ],
      // Deliberately out of depth order: depth 2 child listed before depth 1 parent folder
      sourceNodes: [
        {
          id: 'node-file',
          parentId: 'node-folder',
          type: 'FILE',
          name: 'fig1.png',
          path: '/images/fig1.png',
          depth: 2,
          docId: null,
          fileId: 'file-1',
          sortOrder: 1,
        },
        {
          id: 'node-root-doc',
          parentId: null,
          type: 'DOC',
          name: 'main.tex',
          path: '/main.tex',
          depth: 1,
          docId: 'doc-1',
          fileId: null,
          sortOrder: 0,
        },
        {
          id: 'node-folder',
          parentId: null,
          type: 'FOLDER',
          name: 'images',
          path: '/images',
          depth: 1,
          docId: null,
          fileId: null,
          sortOrder: 1,
        },
      ],
      generateId: makeDeterministicIdGen(),
    });

    expect([...plan.nodeBatchesByDepth.keys()].sort((a, b) => a - b)).toEqual([
      1, 2,
    ]);

    const depth1 = plan.nodeBatchesByDepth.get(1)!;
    const depth2 = plan.nodeBatchesByDepth.get(2)!;
    expect(depth1).toHaveLength(2);
    expect(depth2).toHaveLength(1);

    const clonedDocNode = depth1.find((n) => n.type === 'DOC')!;
    const clonedFolderNode = depth1.find((n) => n.type === 'FOLDER')!;
    const clonedFileNode = depth2[0];

    expect(clonedDocNode.docId).toBe(newPageId);
    expect(clonedFolderNode.parentId).toBeNull();
    expect(clonedFileNode.parentId).toBe(clonedFolderNode.id);
    expect(clonedFileNode.fileId).toBe(plan.filesToCreate[0].id);
  });

  it('prunes orphan nodes with missing parent, missing doc, or missing file', () => {
    const plan = buildClonePlan({
      spaceId,
      newPageId,
      newPageTitle: 'Cloned',
      sourceRootDocId: null,
      sourceDocs: [],
      hydratedDocLinesById: new Map(),
      sourceFiles: [],
      sourceNodes: [
        {
          id: 'orphan-parent',
          parentId: 'missing-folder',
          type: 'FOLDER',
          name: 'sub',
          path: '/missing/sub',
          depth: 2,
          docId: null,
          fileId: null,
        },
        {
          id: 'orphan-doc',
          parentId: null,
          type: 'DOC',
          name: 'ghost.tex',
          path: '/ghost.tex',
          depth: 1,
          docId: 'missing-doc',
          fileId: null,
        },
        {
          id: 'orphan-file',
          parentId: null,
          type: 'FILE',
          name: 'ghost.png',
          path: '/ghost.png',
          depth: 1,
          docId: null,
          fileId: 'missing-file',
        },
      ],
      generateId: makeDeterministicIdGen(),
    });

    expect(plan.nodeBatchesByDepth.size).toBe(0);
  });

  it('aggregates CAS blob ref-count increments across shared PageFiles', () => {
    const plan = buildClonePlan({
      spaceId,
      newPageId,
      newPageTitle: 'Cloned',
      sourceRootDocId: null,
      sourceDocs: [],
      hydratedDocLinesById: new Map(),
      sourceFiles: [
        {
          id: 'f1',
          blobId: 'blob-shared',
          lastKnownPath: 'a.png',
          mimeType: 'image/png',
          sizeBytes: 100,
          hash: 'h',
          storageKey: 'k',
          bucketName: 'b',
        },
        {
          id: 'f2',
          blobId: 'blob-shared',
          lastKnownPath: 'b.png',
          mimeType: 'image/png',
          sizeBytes: 100,
          hash: 'h',
          storageKey: 'k',
          bucketName: 'b',
        },
        {
          id: 'f3',
          blobId: 'blob-unique',
          lastKnownPath: 'c.png',
          mimeType: 'image/png',
          sizeBytes: 200,
          hash: 'h2',
          storageKey: 'k2',
          bucketName: 'b',
        },
        {
          id: 'f4',
          blobId: null,
          lastKnownPath: 'legacy.png',
          mimeType: 'image/png',
          sizeBytes: 50,
          hash: 'h3',
          storageKey: 'k3',
          bucketName: 'b',
        },
      ],
      sourceNodes: [],
      generateId: makeDeterministicIdGen(),
    });

    expect(plan.filesToCreate).toHaveLength(4);
    expect(plan.blobIncrements.get('blob-shared')).toBe(2);
    expect(plan.blobIncrements.get('blob-unique')).toBe(1);
    expect(plan.blobIncrements.size).toBe(2);
  });
});
