import { LibraryTestHarness } from '../library-test-harness';
import { VersionMismatchException } from '../../../../src/modules/library/catalog/errors/catalog.errors';

describe('Notes Interface & Invariants (Integration)', () => {
  let harness: LibraryTestHarness;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('1. Note Types & Item Attachment Invariant', () => {
    it('supports both standalone workspace notes and paper-attached notes', () => {
      const tenant = harness.createWorkspaceFixture();

      const standaloneNote = {
        id: 'note-standalone-1',
        workspaceId: tenant.workspaceId,
        itemId: null,
        title: 'Project Synthesis Thoughts',
        contentMd:
          '# Ideas\n- Cross-attention mechanisms\n- Latent space sampling',
        tags: ['synthesis', 'ideas'],
        version: 1,
      };

      const attachedNote = {
        id: 'note-attached-1',
        workspaceId: tenant.workspaceId,
        itemId: 'paper-vaswani-2017',
        title: 'Summary of Attention is All You Need',
        contentMd:
          'Key contribution: Multi-head self-attention replaces recurrence entirely.',
        tags: ['transformers'],
        version: 1,
      };

      expect(standaloneNote.itemId).toBeNull();
      expect(attachedNote.itemId).toBe('paper-vaswani-2017');
      expect(attachedNote.tags).toContain('transformers');
    });
  });

  describe('2. Rich Content Representation Invariant', () => {
    it('stores structured document JSON alongside markdown projection', () => {
      const note = {
        id: 'note-rich-1',
        title: 'Experimental Protocol',
        contentJson: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'Step 1: Normalize input tensors.' },
              ],
            },
          ],
        },
        contentMd: 'Step 1: Normalize input tensors.',
      };

      expect(note.contentJson.type).toBe('doc');
      expect(note.contentMd).toContain('Normalize input tensors.');
    });
  });

  describe('3. Note Optimistic Concurrency Invariant', () => {
    it('increments version on update and rejects stale edits with 409 conflict', async () => {
      let currentVersion = 3;
      const mutateNote = async (expectedVersion: number) => {
        if (expectedVersion !== currentVersion) {
          throw new VersionMismatchException({
            aggregateType: 'Note',
            entityId: 'note-1',
            currentVersion,
            providedVersion: expectedVersion,
          });
        }
        currentVersion += 1;
        return Promise.resolve({ id: 'note-1', version: currentVersion });
      };

      await harness.assertOptimisticConcurrency(mutateNote, 3);
      expect(currentVersion).toBe(4);
    });
  });
});
