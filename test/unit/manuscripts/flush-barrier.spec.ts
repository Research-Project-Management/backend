/**
 * flush-barrier.spec.ts
 *
 * Unit tests for Pre-Compile Flush Barrier (Overleaf Single Source of Truth Parity).
 * Location: `backend/test/unit/manuscripts/flush-barrier.spec.ts`
 */

import { YjsDocManagerAdapter } from '@/modules/realtime/manuscripts/core/adapters/crdt/yjs-doc-manager.adapter';
import type { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';

describe('Pre-Compile Flush Barrier (YjsDocManagerAdapter.flushProject)', () => {
  let docstoreServiceMock: jest.Mocked<Partial<DocstoreService>>;

  beforeEach(() => {
    docstoreServiceMock = {
      getDoc: jest.fn().mockResolvedValue({ version: 1 } as any),
      updateDoc: jest.fn().mockResolvedValue({ doc: { version: 2 } } as any),
    };
  });

  it('should resolve cleanly when flushing a project with no active sessions', async () => {
    const manager = new YjsDocManagerAdapter(
      undefined,
      docstoreServiceMock as DocstoreService,
    );

    const count = await manager.flushProject('non-existent-project');
    expect(count).toBe(0);
    expect(docstoreServiceMock.updateDoc).not.toHaveBeenCalled();

    await manager.onModuleDestroy();
  });

  it('should flush all in-memory Yjs documents for the specified project to docstore before compile', async () => {
    const manager = new YjsDocManagerAdapter(
      undefined,
      docstoreServiceMock as DocstoreService,
    );

    // Create 2 documents for project-A and 1 for project-B
    const sessionA1 = await manager.getOrCreateDoc('project-A', 'doc-1');
    sessionA1.yText.insert(
      0,
      '\\documentclass{article}\n\\begin{document}\nHello Project A\n\\end{document}',
    );

    const sessionA2 = await manager.getOrCreateDoc('project-A', 'doc-2');
    sessionA2.yText.insert(0, '\\section{Chapter 2}');

    const sessionB1 = await manager.getOrCreateDoc('project-B', 'doc-3');
    sessionB1.yText.insert(0, 'Project B content');

    // Trigger Pre-Compile Flush Barrier for project-A
    const flushedCount = await manager.flushProject('project-A');
    expect(flushedCount).toBe(2);

    // Documents from project-A must be flushed to docstore
    expect(docstoreServiceMock.updateDoc).toHaveBeenCalledWith(
      'project-A',
      'doc-1',
      expect.objectContaining({
        lines: expect.arrayContaining([
          '\\documentclass{article}',
          'Hello Project A',
        ]),
      }),
    );
    expect(docstoreServiceMock.updateDoc).toHaveBeenCalledWith(
      'project-A',
      'doc-2',
      expect.objectContaining({
        lines: ['\\section{Chapter 2}'],
      }),
    );

    // Document from project-B must NOT be flushed
    expect(docstoreServiceMock.updateDoc).not.toHaveBeenCalledWith(
      'project-B',
      expect.anything(),
      expect.anything(),
    );

    await manager.onModuleDestroy();
  });
});
