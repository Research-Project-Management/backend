import {
  TreeEngine,
  ConditionEvaluatorEngine,
} from '@/modules/library/catalog';
import { cleanDoi, isValidDoi } from '@/modules/library/core';

describe('Catalog Bounded Context - Modular Monolith Domain Engines', () => {
  describe('DOI Domain Logic', () => {
    it('cleanDoi and isValidDoi should validate and normalize DOIs to lowercase', () => {
      const rawDoi = 'https://doi.org/10.1000/182.XYZ';
      expect(isValidDoi(rawDoi)).toBe(true);
      expect(cleanDoi(rawDoi)).toBe('10.1000/182.xyz');

      expect(cleanDoi('10.1000/182.xyz')).toBe('10.1000/182.xyz');
      expect(isValidDoi('invalid-doi')).toBe(false);
      expect(cleanDoi(null)).toBe('');
    });
  });

  describe('Collection Tree Engine', () => {
    it('TreeEngine.buildTree should hierarchically nest child collections', () => {
      const collections = [
        { id: 'c1', name: 'Root', parentId: null, sortOrder: 0 },
        { id: 'c2', name: 'Child A', parentId: 'c1', sortOrder: 0 },
        { id: 'c3', name: 'Child B', parentId: 'c1', sortOrder: 1 },
      ];

      const tree = new TreeEngine().buildTree(collections);
      expect(tree).toHaveLength(1);
      expect(tree[0].id).toBe('c1');
      expect((tree[0] as any).children).toHaveLength(2);
      expect((tree[0] as any).children[0].id).toBe('c2');
      expect((tree[0] as any).children[1].id).toBe('c3');
    });
  });

  describe('Smart Collection Condition Evaluator Engine', () => {
    it('should compile title condition group into Prisma query', async () => {
      const engine = new ConditionEvaluatorEngine();
      const where = await engine.compile('user-1', {
        conjunction: 'AND',
        conditions: [
          { field: 'title', operator: 'contains', value: 'Residual Learning' },
        ],
      });

      expect(where).toBeDefined();
      expect(where.AND).toBeDefined();
      expect((where.AND as any)[0].userId).toBe('user-1');
      expect((where.AND as any)[0].deletedAt).toBeNull();
    });
  });
});
