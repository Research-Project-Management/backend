import { TreeEngine } from '../../src/modules/library/collections/engines/tree.engine';
import { BadRequestException } from '@nestjs/common';

describe('TreeEngine (Matt Pocock Pattern)', () => {
  let engine: TreeEngine;

  beforeEach(() => {
    engine = new TreeEngine();
  });

  describe('buildTree', () => {
    it('builds a multi-level nested hierarchy from a flat list', () => {
      const collections = [
        { id: 'c1', name: 'Root 1', parentId: null, itemCount: 5 },
        { id: 'c2', name: 'Child 1.1', parentId: 'c1', itemCount: 2 },
        { id: 'c3', name: 'Grandchild 1.1.1', parentId: 'c2', itemCount: 1 },
        { id: 'c4', name: 'Root 2', parentId: null, itemCount: 0 },
      ];

      const tree = engine.buildTree(collections);

      expect(tree).toHaveLength(2); // Two roots: c1, c4
      expect(tree[0].id).toBe('c1');
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children[0].id).toBe('c2');
      expect(tree[0].children[0].children).toHaveLength(1);
      expect(tree[0].children[0].children[0].id).toBe('c3');
      expect(tree[1].id).toBe('c4');
      expect(tree[1].children).toHaveLength(0);
    });

    it('treats items with non-existent parentId as roots', () => {
      const collections = [
        {
          id: 'c1',
          name: 'Orphan Child',
          parentId: 'missing-parent',
          itemCount: 3,
        },
      ];

      const tree = engine.buildTree(collections);
      expect(tree).toHaveLength(1);
      expect(tree[0].id).toBe('c1');
    });
  });

  describe('detectCycle', () => {
    it('detects direct circular reference where collection is its own parent', () => {
      const collections = [{ id: 'c1', name: 'A', parentId: null }];
      expect(engine.detectCycle(collections, 'c1', 'c1')).toBe(true);
    });

    it('detects indirect 2-level cycle (A -> B -> A)', () => {
      const collections = [
        { id: 'c1', name: 'A', parentId: null },
        { id: 'c2', name: 'B', parentId: 'c1' },
      ];
      // Attempting to make c1's parent c2 (c2 -> c1 -> c2 cycle)
      expect(engine.detectCycle(collections, 'c1', 'c2')).toBe(true);
    });

    it('detects deep multi-level cycle (A -> B -> C -> D -> A)', () => {
      const collections = [
        { id: 'c1', name: 'A', parentId: null },
        { id: 'c2', name: 'B', parentId: 'c1' },
        { id: 'c3', name: 'C', parentId: 'c2' },
        { id: 'c4', name: 'D', parentId: 'c3' },
      ];
      // Moving A to be child of D
      expect(engine.detectCycle(collections, 'c1', 'c4')).toBe(true);
      // Moving B to be child of D
      expect(engine.detectCycle(collections, 'c2', 'c4')).toBe(true);
    });

    it('returns false for safe hierarchy moves', () => {
      const collections = [
        { id: 'c1', name: 'Root 1', parentId: null },
        { id: 'c2', name: 'Child 1.1', parentId: 'c1' },
        { id: 'c3', name: 'Root 2', parentId: null },
        { id: 'c4', name: 'Child 2.1', parentId: 'c3' },
      ];
      // Moving c2 to become child of c3 (safe cross-tree move)
      expect(engine.detectCycle(collections, 'c2', 'c3')).toBe(false);
      // Moving c2 to become child of c4 (safe)
      expect(engine.detectCycle(collections, 'c2', 'c4')).toBe(false);
    });
  });

  describe('assertNoCycle', () => {
    it('throws BadRequestException when circular hierarchy is detected', () => {
      const collections = [
        { id: 'c1', name: 'A', parentId: null },
        { id: 'c2', name: 'B', parentId: 'c1' },
      ];

      expect(() => engine.assertNoCycle(collections, 'c1', 'c2')).toThrow(
        BadRequestException,
      );
    });

    it('does not throw when hierarchy move is valid', () => {
      const collections = [
        { id: 'c1', name: 'A', parentId: null },
        { id: 'c2', name: 'B', parentId: null },
      ];

      expect(() => engine.assertNoCycle(collections, 'c2', 'c1')).not.toThrow();
    });
  });

  describe('getDescendantIds', () => {
    it('returns empty array for leaf collections without children', () => {
      const collections = [
        { id: 'c1', name: 'Root', parentId: null },
        { id: 'c2', name: 'Leaf', parentId: 'c1' },
      ];
      expect(engine.getDescendantIds(collections, 'c2')).toEqual([]);
    });

    it('collects all transitive children across multiple generation tiers', () => {
      const collections = [
        { id: 'c1', name: 'A', parentId: null },
        { id: 'c2', name: 'B', parentId: 'c1' },
        { id: 'c3', name: 'C', parentId: 'c1' },
        { id: 'c4', name: 'D', parentId: 'c2' },
        { id: 'c5', name: 'E', parentId: 'c4' },
      ];

      const descendants = engine.getDescendantIds(collections, 'c1');
      expect(descendants).toContain('c2');
      expect(descendants).toContain('c3');
      expect(descendants).toContain('c4');
      expect(descendants).toContain('c5');
      expect(descendants).toHaveLength(4);
    });
  });
});
