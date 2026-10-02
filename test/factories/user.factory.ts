export interface MockUser {
  id: string;
  email: string;
  name: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Builds a valid mock User entity with sensible defaults (Object Mother Pattern).
 */
export function buildMockUser(overrides: Partial<MockUser> = {}): MockUser {
  const defaultId = '01920b92-1111-7111-8111-111111111111';
  return {
    id: overrides.id ?? defaultId,
    email: overrides.email ?? 'researcher@flux.app',
    name: overrides.name ?? 'Dr. Ada Lovelace',
    role: overrides.role ?? 'RESEARCHER',
    createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}
