/**
 * Centralized Mock Prisma Service Provider
 * Eliminates repetitive mock definitions across unit tests.
 */
export function createMockPrismaService() {
  const createModelMock = () => ({
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn((args) => Promise.resolve(args?.data ?? args)),
    createMany: jest.fn(),
    update: jest.fn((args) => Promise.resolve(args?.data ?? args)),
    updateMany: jest.fn(),
    upsert: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn(),
    groupBy: jest.fn(),
  });

  const mockClient: any = {
    user: createModelMock(),
    project: createModelMock(),
    projectMember: createModelMock(),
    item: createModelMock(),
    itemCollection: createModelMock(),
    itemTag: createModelMock(),
    attachment: createModelMock(),
    collection: createModelMock(),
    tag: createModelMock(),
    workItem: createModelMock(),
    sticky: createModelMock(),
    capturePreview: createModelMock(),
    $transaction: jest.fn((input) => {
      if (typeof input === 'function') {
        return input(mockClient);
      }
      return Promise.all(input);
    }),
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
  };

  return mockClient;
}
