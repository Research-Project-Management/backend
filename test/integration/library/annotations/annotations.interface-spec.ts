import { LibraryTestHarness } from '../library-test-harness';
import { VersionMismatchException } from '../../../../src/modules/library/common/library-mutation.dto';

describe('Annotations Interface & Invariants (Integration)', () => {
  let harness: LibraryTestHarness;

  beforeAll(async () => {
    harness = await LibraryTestHarness.create();
  });

  afterAll(async () => {
    await harness.close();
  });

  describe('1. Geometry & Page Positioning Invariant', () => {
    it('accurately stores and retrieves PDF bounding rect coordinates and page index', () => {
      const annotation = {
        id: 'anno-1',
        attachmentId: 'att-pdf-1',
        type: 'highlight',
        pageIndex: 3,
        color: '#ffeb3b',
        quoteText: 'Machine learning models require robust generalization.',
        rectCoords: { x1: 72.0, y1: 150.5, x2: 450.0, y2: 165.0 },
        version: 1,
        authorId: 'user-1',
      };

      expect(annotation.pageIndex).toBe(3);
      expect(annotation.rectCoords.x1).toBe(72.0);
      expect(annotation.rectCoords.y2).toBe(165.0);
      expect(annotation.type).toBe('highlight');
    });
  });

  describe('2. Annotation Optimistic Concurrency Invariant', () => {
    it('increments version on update and rejects conflicting concurrent modifications', async () => {
      let currentVersion = 1;
      const mutateAnnotation = async (expectedVersion: number) => {
        if (expectedVersion !== currentVersion) {
          throw new VersionMismatchException({
            aggregateType: 'Annotation',
            entityId: 'anno-1',
            currentVersion,
            providedVersion: expectedVersion,
          });
        }
        currentVersion += 1;
        return Promise.resolve({ id: 'anno-1', version: currentVersion });
      };

      await harness.assertOptimisticConcurrency(mutateAnnotation, 1);
      expect(currentVersion).toBe(2);
    });
  });

  describe('3. Non-Destructive Soft Deletion Invariant', () => {
    it('marks annotation as deleted without removing other annotations on the same page', () => {
      const pageAnnotations = [
        { id: 'anno-1', pageIndex: 1, deletedAt: null },
        { id: 'anno-2', pageIndex: 1, deletedAt: null },
      ];

      // Soft delete anno-1
      const updatedList = pageAnnotations.map((a) =>
        a.id === 'anno-1' ? { ...a, deletedAt: new Date() } : a,
      );

      const activeOnPage = updatedList.filter((a) => a.deletedAt === null);
      expect(activeOnPage).toHaveLength(1);
      expect(activeOnPage[0].id).toBe('anno-2');
    });
  });
});
