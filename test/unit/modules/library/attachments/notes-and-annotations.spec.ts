import { NotesService } from '@/modules/library/notes/notes.service';
import { AttachmentsService } from '@/modules/library/attachments/attachments.service';
import { AnnotationsService } from '@/modules/library/annotations/annotations.service';

import { ItemsRepository } from '@/modules/library/items/items.repository';

describe('Phase 7: Attachments, Notes & Annotations Subsystem', () => {
  let notesService: NotesService;
  let attachmentsService: AttachmentsService;
  let annotationsService: AnnotationsService;
  let mockCatalogRepo: any;
  let extraStore: ItemsRepository;

  const mockItem = {
    id: 'item-ann-101',
    workspaceId: 'ws-1',
    title: 'Attention Is All You Need',
    notes: [],
    attachments: [],
    deletedAt: null,
  };

  beforeEach(() => {
    mockCatalogRepo = {
      resolveWorkspaceId: jest
        .fn()
        .mockImplementation((ws) => Promise.resolve(ws)),
      findItemById: jest.fn().mockImplementation((id) => {
        if (id === mockItem.id) return Promise.resolve({ ...mockItem });
        return Promise.resolve(null);
      }),
      findItemByIdInWorkspace: jest.fn().mockImplementation((ws, id) => {
        if (id === mockItem.id) return Promise.resolve({ ...mockItem });
        return Promise.resolve(null);
      }),
      findItems: jest
        .fn()
        .mockImplementation(() => Promise.resolve([{ ...mockItem }])),
      updateItem: jest.fn().mockImplementation((id, data) => {
        Object.assign(mockItem, data);
        return Promise.resolve(mockItem);
      }),
      mutatePaperExtra: jest.fn().mockImplementation((paperId, mutator) => {
        let extraObj: any = {};
        try {
          extraObj = (mockItem as any).extra
            ? JSON.parse((mockItem as any).extra)
            : {};
        } catch {
          extraObj = {};
        }
        const updatedExtra = mutator(extraObj);
        (mockItem as any).extra = JSON.stringify(updatedExtra);
        return Promise.resolve({ paper: mockItem, extraObj: updatedExtra });
      }),
      getAnnotations: jest.fn().mockImplementation((paperId) => {
        try {
          const extra = JSON.parse((mockItem as any).extra || '{}');
          return Promise.resolve(extra.annotations || []);
        } catch {
          return Promise.resolve([]);
        }
      }),
      putAnnotation: jest.fn().mockImplementation((paperId, ann) => {
        let extra: any = {};
        try {
          extra = JSON.parse((mockItem as any).extra || '{}');
        } catch {
          extra = {};
        }
        extra.annotations = [...(extra.annotations || []), ann];
        (mockItem as any).extra = JSON.stringify(extra);
        return Promise.resolve(extra.annotations);
      }),
      replaceAnnotation: jest.fn().mockImplementation((paperId, id, patch) => {
        let extra: any = {};
        try {
          extra = JSON.parse((mockItem as any).extra || '{}');
        } catch {
          extra = {};
        }
        const list = extra.annotations || [];
        const idx = list.findIndex((a: any) => a.id === id);
        if (idx === -1) return Promise.resolve(null);
        list[idx] = { ...list[idx], ...patch };
        extra.annotations = list;
        (mockItem as any).extra = JSON.stringify(extra);
        return Promise.resolve(list[idx]);
      }),
      removeAnnotation: jest.fn().mockImplementation((paperId, id) => {
        let extra: any = {};
        try {
          extra = JSON.parse((mockItem as any).extra || '{}');
        } catch {
          extra = {};
        }

        const list = extra.annotations || [];
        const filtered = list.filter((a: any) => a.id !== id);
        extra.annotations = filtered;
        (mockItem as any).extra = JSON.stringify(extra);
        return Promise.resolve(filtered.length);
      }),
    };

    notesService = new NotesService(mockCatalogRepo);
    attachmentsService = new AttachmentsService({} as any, mockCatalogRepo);
    annotationsService = new AnnotationsService(mockCatalogRepo);
  });

  describe('Attachments & SHA-256 Hashing', () => {
    it('calculates deterministic SHA-256 file fingerprint', () => {
      const content = 'PDF binary stream test data';
      const hash1 = attachmentsService.calculateFileHash(content);
      const hash2 = attachmentsService.calculateFileHash(content);

      expect(hash1).toBeDefined();
      expect(hash1.length).toBe(64); // 64 hex chars = 256 bits
      expect(hash1).toBe(hash2);
    });

    it('adds attachment with fileHash and revision entry', async () => {
      const result = await attachmentsService.addAttachment(
        'ws-1',
        'item-ann-101',
        {
          filename: 'paper.pdf',
          mimeType: 'application/pdf',
          size: 102456,
          url: 'https://example.com/paper.pdf',
          content: 'dummy pdf content',
        },
      );

      expect(result.attachment).toBeDefined();
      expect(result.attachment.filename).toBe('paper.pdf');
      expect(result.attachment.fileHash).toBeDefined();
      expect(result.attachment.revisions.length).toBe(1);
      expect(result.attachment.revisions[0].revisionNumber).toBe(1);
    });
  });

  describe('Notes Management (Standalone & Child Notes)', () => {
    it('creates and updates a child note attached to an item', async () => {
      const created = await notesService.createNote('ws-1', {
        itemId: 'item-ann-101',
        title: 'Key Insights',
        content: 'Self-attention scales with O(N^2) complexity.',
        tags: ['attention', 'complexity'],
      });

      expect(created.itemId).toBe('item-ann-101');
      expect(created.title).toBe('Key Insights');
      expect(created.version).toBe(1);

      // Update the note
      const updated = await notesService.updateNote('ws-1', created.id, {
        content: 'Self-attention scales with O(N^2) memory complexity.',
      });

      expect(updated.content).toContain('memory complexity');
      expect(updated.version).toBe(2);
    });

    it('creates and lists standalone notes', async () => {
      const standalone = await notesService.createNote('ws-1', {
        title: 'Project Roadmap Notes',
        content: 'Investigate sparse transformers.',
      });

      expect(standalone.itemId).toBeNull();

      const allNotes = await notesService.getNotes('ws-1');
      expect(allNotes.some((n: any) => n.id === standalone.id)).toBe(true);
    });
  });

  describe('Annotations & Literature Note Synthesis', () => {
    it('creates PDF highlight annotations and extracts literature note markdown', async () => {
      await annotationsService.createAnnotation(
        'ws-1',
        'item-ann-101',
        'user-1',
        {
          attachmentId: 'att-1',
          type: 'highlight',
          pageNumber: 1,
          color: '#ffeb3b',
          quote:
            'The Transformer is the first transduction model relying entirely on self-attention.',
          comment: 'Core thesis of the architecture',
        },
      );

      await annotationsService.createAnnotation(
        'ws-1',
        'item-ann-101',
        'user-1',
        {
          attachmentId: 'att-1',
          type: 'highlight',
          pageNumber: 3,
          color: '#4caf50',
          quote:
            'Multi-Head Attention allows the model to jointly attend to information from different representation subspaces.',
          comment: 'Key mechanism detail',
        },
      );

      const { annotations, total } = await annotationsService.getAnnotations(
        'ws-1',
        'item-ann-101',
      );
      expect(total).toBe(2);
      expect(annotations[0].quote).toContain('Transformer');

      // Reference Manager parity: "Add Note from Annotations"
      const { literatureNote } =
        await annotationsService.extractNotesFromAnnotations(
          'ws-1',
          'item-ann-101',
          'user-1',
        );

      expect(literatureNote.annotationCount).toBe(2);
      expect(literatureNote.content).toContain('### 📄 Page 1');
      expect(literatureNote.content).toContain(
        'Core thesis of the architecture',
      );
      expect(literatureNote.content).toContain('### 📄 Page 3');
      expect(literatureNote.content).toContain('Key mechanism detail');
    });
  });
});
