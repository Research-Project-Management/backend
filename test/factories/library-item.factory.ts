export interface MockLibraryItem {
  id: string;
  userId: string;
  projectId?: string | null;
  title: string;
  itemType: string;
  citationKey?: string | null;
  publicationTitle?: string | null;
  publisher?: string | null;
  year?: number | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  doi?: string | null;
  url?: string | null;
  abstract?: string | null;
  version: number;
  isDeleted?: boolean;
  deletedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  contributors?: Array<{
    firstName: string;
    lastName: string;
    role: string;
    orderIndex: number;
  }>;
  attachments?: any[];
  tags?: any[];
}

/**
 * Builds a valid mock Library Item with standard Zotero/BibTeX metadata (Object Mother Pattern).
 */
export function buildMockLibraryItem(
  overrides: Partial<MockLibraryItem> = {},
): MockLibraryItem {
  return {
    id: overrides.id ?? '01920b92-2222-7222-8222-222222222222',
    userId: overrides.userId ?? '01920b92-1111-7111-8111-111111111111',
    projectId: overrides.projectId ?? null,
    title: overrides.title ?? 'Attention Is All You Need',
    itemType: overrides.itemType ?? 'journalArticle',
    citationKey: overrides.citationKey ?? 'vaswani2017attention',
    publicationTitle:
      overrides.publicationTitle ??
      'Advances in Neural Information Processing Systems',
    publisher: overrides.publisher ?? null,
    year: overrides.year !== undefined ? overrides.year : 2017,
    volume: overrides.volume ?? '30',
    issue: overrides.issue ?? null,
    pages: overrides.pages ?? '5998-6008',
    doi: overrides.doi ?? '10.5555/3295222.3295349',
    url: overrides.url ?? 'https://arxiv.org/abs/1706.03762',
    abstract:
      overrides.abstract ??
      'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks...',
    version: overrides.version ?? 1,
    isDeleted: overrides.isDeleted ?? false,
    deletedAt: overrides.deletedAt ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-01-01T00:00:00.000Z'),
    contributors: overrides.contributors ?? [
      {
        firstName: 'Ashish',
        lastName: 'Vaswani',
        role: 'author',
        orderIndex: 0,
      },
      { firstName: 'Noam', lastName: 'Shazeer', role: 'author', orderIndex: 1 },
    ],
    attachments: overrides.attachments ?? [],
    tags: overrides.tags ?? [],
    ...overrides,
  };
}
