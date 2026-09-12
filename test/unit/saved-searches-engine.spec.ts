import { ConditionEvaluatorEngine } from '../../src/modules/library/saved-searches/engines/condition-evaluator.engine';
import { SavedSearchConditionGroup } from '../../src/modules/library/saved-searches/types/saved-search.types';

describe('ConditionEvaluatorEngine', () => {
  let engine: ConditionEvaluatorEngine;
  const userId = 'user-123';
  const baseWhere = {
    OR: [{ userId }, { workspaceId: userId }],
    deletedAt: null,
  };

  beforeEach(() => {
    engine = new ConditionEvaluatorEngine();
  });

  it('returns base user filter when condition group is empty', () => {
    const group: SavedSearchConditionGroup = {
      conjunction: 'AND',
      conditions: [],
    };

    const where = engine.compile(userId, group);
    expect(where).toEqual(baseWhere);
  });

  it('evaluates string title contains condition', () => {
    const group: SavedSearchConditionGroup = {
      conjunction: 'AND',
      conditions: [
        { field: 'title', operator: 'contains', value: 'Machine Learning' },
      ],
    };

    const where = engine.compile(userId, group);
    expect(where.AND).toBeDefined();
    expect((where.AND as any[])[0]).toEqual(baseWhere);
    expect((where.AND as any[])[1]).toEqual({
      AND: [{ title: { contains: 'Machine Learning', mode: 'insensitive' } }],
    });
  });

  it('evaluates year isGreaterThan condition', () => {
    const group: SavedSearchConditionGroup = {
      conjunction: 'AND',
      conditions: [{ field: 'year', operator: 'isGreaterThan', value: 2020 }],
    };

    const where = engine.compile(userId, group);
    expect((where.AND as any[])[1]).toEqual({
      AND: [{ year: { gt: 2020 } }],
    });
  });

  it('evaluates year isBetween condition with array value', () => {
    const group: SavedSearchConditionGroup = {
      conjunction: 'AND',
      conditions: [
        { field: 'year', operator: 'isBetween', value: [2018, 2024] },
      ],
    };

    const where = engine.compile(userId, group);
    expect((where.AND as any[])[1]).toEqual({
      AND: [{ year: { gte: 2018, lte: 2024 } }],
    });
  });

  it('evaluates tag contains condition', () => {
    const group: SavedSearchConditionGroup = {
      conjunction: 'AND',
      conditions: [{ field: 'tag', operator: 'contains', value: 'review' }],
    };

    const where = engine.compile(userId, group);
    expect((where.AND as any[])[1]).toEqual({
      AND: [
        {
          itemTags: {
            some: {
              tag: {
                name: { contains: 'review', mode: 'insensitive' },
              },
            },
          },
        },
      ],
    });
  });

  it('evaluates creator author matching', () => {
    const group: SavedSearchConditionGroup = {
      conjunction: 'AND',
      conditions: [{ field: 'creator', operator: 'contains', value: 'LeCun' }],
    };

    const where = engine.compile(userId, group);
    expect((where.AND as any[])[1]).toEqual({
      AND: [
        {
          contributors: {
            some: {
              fullName: { contains: 'LeCun', mode: 'insensitive' },
            },
          },
        },
      ],
    });
  });

  it('evaluates hasAttachment true and false', () => {
    const groupTrue: SavedSearchConditionGroup = {
      conjunction: 'AND',
      conditions: [{ field: 'hasAttachment', operator: 'is', value: true }],
    };
    const whereTrue = engine.compile(userId, groupTrue);
    expect((whereTrue.AND as any[])[1]).toEqual({
      AND: [{ attachments: { some: {} } }],
    });

    const groupFalse: SavedSearchConditionGroup = {
      conjunction: 'AND',
      conditions: [{ field: 'hasAttachment', operator: 'is', value: false }],
    };
    const whereFalse = engine.compile(userId, groupFalse);
    expect((whereFalse.AND as any[])[1]).toEqual({
      AND: [{ attachments: { none: {} } }],
    });
  });

  it('evaluates readStatus unread and completed with userId', () => {
    const groupUnread: SavedSearchConditionGroup = {
      conjunction: 'AND',
      conditions: [{ field: 'readStatus', operator: 'is', value: 'unread' }],
    };
    const whereUnread = engine.compile(userId, groupUnread);
    expect((whereUnread.AND as any[])[1]).toEqual({
      AND: [
        {
          OR: [
            { states: { none: { userId } } },
            { states: { some: { userId, readStatus: 'unread' } } },
          ],
        },
      ],
    });

    const groupCompleted: SavedSearchConditionGroup = {
      conjunction: 'AND',
      conditions: [{ field: 'readStatus', operator: 'is', value: 'completed' }],
    };
    const whereCompleted = engine.compile(userId, groupCompleted);
    expect((whereCompleted.AND as any[])[1]).toEqual({
      AND: [
        {
          states: {
            some: {
              userId,
              readStatus: 'completed',
            },
          },
        },
      ],
    });
  });

  it('evaluates nested condition groups with OR conjunction', () => {
    const group: SavedSearchConditionGroup = {
      conjunction: 'OR',
      conditions: [
        { field: 'year', operator: 'isLessThan', value: 2000 },
        {
          conjunction: 'AND',
          conditions: [
            { field: 'year', operator: 'isGreaterThan', value: 2020 },
            { field: 'tag', operator: 'contains', value: 'ai' },
          ],
        },
      ],
    };

    const where = engine.compile(userId, group);
    const orClauses = (where.AND as any[])[1].OR;
    expect(orClauses).toHaveLength(2);
    expect(orClauses[0]).toEqual({ year: { lt: 2000 } });
    expect(orClauses[1].AND).toHaveLength(2);
  });
});
