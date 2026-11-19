import { StorageFile as PrismaFile, Prisma } from '@prisma/client';
import { getFileContentPath } from '../experiments.type';
import { FileScope, normalizeFileScope, ExperimentNode } from './node.domain';
import { ExperimentVersion, ExperimentVersionAuthor } from './version.domain';

export const FILE_AUTHOR_SELECT = {
  id: true,
  email: true,
  profile: {
    select: {
      name: true,
      avatar: true,
    },
  },
} as const;

export type PrismaFileWithAuthor = PrismaFile & {
  createdBy?: {
    id: string;
    email: string | null;
    profile?: {
      name: string | null;
      avatar: string | null;
    } | null;
  } | null;
  stars?: Array<{ userId: string }>;
};

export function buildFileTypeCondition(
  rawType: string,
): Prisma.StorageFileWhereInput | null {
  const t = rawType.trim().toLowerCase();
  if (!t) return null;
  if (t === 'folder' || t === 'directory') {
    return { isFolder: true };
  }
  if (t === 'pdf') {
    return {
      isFolder: false,
      OR: [
        { mimeType: { contains: 'pdf', mode: 'insensitive' } },
        { filename: { endsWith: '.pdf', mode: 'insensitive' } },
      ],
    };
  }
  if (t === 'image' || t === 'images') {
    return {
      isFolder: false,
      mimeType: { startsWith: 'image/', mode: 'insensitive' },
    };
  }
  if (t === 'video' || t === 'videos') {
    return {
      isFolder: false,
      mimeType: { startsWith: 'video/', mode: 'insensitive' },
    };
  }
  if (t === 'audio') {
    return {
      isFolder: false,
      mimeType: { startsWith: 'audio/', mode: 'insensitive' },
    };
  }
  if (t === 'spreadsheet' || t === 'csv' || t === 'excel') {
    return {
      isFolder: false,
      OR: [
        { mimeType: { contains: 'spreadsheet', mode: 'insensitive' } },
        { mimeType: { contains: 'excel', mode: 'insensitive' } },
        { mimeType: { contains: 'csv', mode: 'insensitive' } },
        { filename: { endsWith: '.csv', mode: 'insensitive' } },
        { filename: { endsWith: '.xlsx', mode: 'insensitive' } },
        { filename: { endsWith: '.xls', mode: 'insensitive' } },
      ],
    };
  }
  if (t === 'document' || t === 'doc' || t === 'text') {
    return {
      isFolder: false,
      OR: [
        { mimeType: { startsWith: 'text/', mode: 'insensitive' } },
        { mimeType: { contains: 'word', mode: 'insensitive' } },
        { mimeType: { contains: 'document', mode: 'insensitive' } },
        { mimeType: { contains: 'latex', mode: 'insensitive' } },
        { mimeType: { contains: 'tex', mode: 'insensitive' } },
      ],
    };
  }
  if (t === 'archive' || t === 'zip') {
    return {
      isFolder: false,
      OR: [
        { mimeType: { contains: 'zip', mode: 'insensitive' } },
        { mimeType: { contains: 'tar', mode: 'insensitive' } },
        { mimeType: { contains: 'gzip', mode: 'insensitive' } },
        { mimeType: { contains: 'compressed', mode: 'insensitive' } },
      ],
    };
  }
  return {
    isFolder: false,
    OR: [
      { mimeType: { contains: t, mode: 'insensitive' } },
      {
        filename: {
          endsWith: `.${t.replace(/^\./, '')}`,
          mode: 'insensitive',
        },
      },
    ],
  };
}

export function applyFileTypeFilter(
  where: Prisma.StorageFileWhereInput,
  types?: string[],
): void {
  if (!types || types.length === 0) return;
  const typeConditions = types
    .map(buildFileTypeCondition)
    .filter((c): c is Prisma.StorageFileWhereInput => c !== null);

  if (typeConditions.length === 1) {
    Object.assign(where, typeConditions[0]);
  } else if (typeConditions.length > 1) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      { OR: typeConditions },
    ];
  }
}

export function parseFileOrderBy(
  sortBy?: string,
  sortOrder?: 'asc' | 'desc',
): Prisma.StorageFileOrderByWithRelationInput[] {
  const defaultOrder: Prisma.StorageFileOrderByWithRelationInput[] = [
    { isFolder: 'desc' },
    { filename: 'asc' },
  ];
  if (!sortBy) return defaultOrder;

  const normalized = sortBy.trim().toLowerCase();
  if (normalized === 'date-desc') {
    return [{ isFolder: 'desc' }, { updatedAt: 'desc' }];
  }
  if (normalized === 'date-asc') {
    return [{ isFolder: 'desc' }, { updatedAt: 'asc' }];
  }
  if (normalized === 'name-asc') {
    return [{ isFolder: 'desc' }, { filename: 'asc' }];
  }
  if (normalized === 'name-desc') {
    return [{ isFolder: 'desc' }, { filename: 'desc' }];
  }
  if (normalized === 'size-desc') {
    return [{ isFolder: 'desc' }, { size: 'desc' }];
  }
  if (normalized === 'size-asc') {
    return [{ isFolder: 'desc' }, { size: 'asc' }];
  }

  const orderDir: 'asc' | 'desc' = sortOrder === 'desc' ? 'desc' : 'asc';
  if (
    normalized === 'updatedat' ||
    normalized === 'updated_at' ||
    normalized === 'date'
  ) {
    return [{ isFolder: 'desc' }, { updatedAt: orderDir }];
  }
  if (normalized === 'createdat' || normalized === 'created_at') {
    return [{ isFolder: 'desc' }, { createdAt: orderDir }];
  }
  if (normalized === 'size') {
    return [{ isFolder: 'desc' }, { size: orderDir }];
  }
  if (normalized === 'name' || normalized === 'filename') {
    return [{ isFolder: 'desc' }, { filename: orderDir }];
  }

  return defaultOrder;
}

export class NodeMapper {
  public static toDomain(record: PrismaFileWithAuthor): ExperimentNode {
    const isProjectSpace =
      record.spaceId && record.spaceId !== record.createdById;
    const scope = normalizeFileScope(
      record.linkedToType,
      Boolean(isProjectSpace),
    );
    const metadata = (record.metadata as Record<string, unknown>) || {};
    const projectId =
      (typeof metadata.projectId === 'string' ? metadata.projectId : null) ??
      (isProjectSpace
        ? record.spaceId
        : scope === FileScope.Project
          ? record.linkedToId
          : null);
    const isStarred =
      Array.isArray(record.stars) && record.stars.length > 0
        ? true
        : Boolean(metadata.starred);
    return new ExperimentNode({
      id: record.id,
      projectId,
      linkedToId: record.linkedToId ?? (isProjectSpace ? record.spaceId : null),
      parentId: record.parentId,
      name: record.filename,
      isFolder: record.isFolder,
      size: BigInt(record.size),
      mimeType: record.mimeType,
      blobId: record.blobId,
      scope,
      starred: isStarred,
      metadata,
      authorId: record.createdById,
      author: record.createdBy
        ? {
            id: record.createdBy.id,
            email: record.createdBy.email,
            name: record.createdBy.profile?.name ?? null,
            avatar: record.createdBy.profile?.avatar ?? null,
          }
        : null,
      trashedAt: record.deletedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  public static toPrismaCreate(node: ExperimentNode) {
    const metadata =
      node.projectId && node.scope !== FileScope.Project
        ? { ...node.metadata, projectId: node.projectId }
        : node.metadata;
    const spaceId = node.projectId || node.authorId;
    return {
      id: node.id,
      spaceId,
      createdById: node.authorId,
      filename: node.name,
      size: node.size,
      mimeType: node.mimeType,
      isFolder: node.isFolder,
      metadata: metadata as Prisma.InputJsonValue,
      parentId: node.parentId,
      linkedToType: node.scope,
      linkedToId: node.linkedToId ?? node.projectId,
      blobId: node.blobId,
      deletedAt: node.trashedAt,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    };
  }
}

export const VERSION_AUTHOR_SELECT = {
  id: true,
  email: true,
  profile: {
    select: {
      name: true,
      avatar: true,
    },
  },
} as const;

export function mapVersionAuthor(
  user: {
    id: string;
    email: string | null;
    profile?: { name: string; avatar: string | null } | null;
  } | null,
): ExperimentVersionAuthor | null {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.profile?.name ?? 'User',
    avatar: user.profile?.avatar ?? null,
  };
}

export class VersionMapper {
  public static toDomain(
    record: {
      id: string;
      fileId: string;
      blobId: string;
      versionNumber: number;
      sizeBytes?: bigint | null;
      mimeType?: string | null;
      changeComment: string | null;
      createdById: string;
      createdAt: Date;
      blob?: { sizeBytes: bigint } | null;
    },
    author: ExperimentVersionAuthor | null,
  ): ExperimentVersion {
    return new ExperimentVersion({
      id: record.id,
      fileId: record.fileId,
      blobId: record.blobId,
      versionNumber: record.versionNumber,
      changeComment: record.changeComment,
      createdById: record.createdById,
      createdAt: record.createdAt,
      sizeBytes: record.sizeBytes ?? record.blob?.sizeBytes ?? 0n,
      mimeType: record.mimeType ?? undefined,
      author,
    });
  }
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export interface PaginationParams {
  take: number;
  skip: number;
  currentPage: number;
}

export function parsePagination(
  limit?: number,
  offset?: number,
  page?: number,
): PaginationParams {
  const take = limit ? Number(limit) : 100;
  const skip =
    offset !== undefined
      ? Number(offset)
      : page
        ? (Number(page) - 1) * take
        : 0;
  const currentPage = page ? Number(page) : Math.floor(skip / take) + 1;
  return { take, skip, currentPage };
}

export function parseTypesQuery(
  types?: string,
  type?: string,
): string[] | undefined {
  if (types) {
    const parsed = types
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    return parsed.length > 0 ? parsed : undefined;
  }
  if (type && type !== 'all') {
    return [type.trim()];
  }
  return undefined;
}

export function mapExperimentNodeToDto(node: ExperimentNode) {
  const metadataAuthor =
    node.metadata?.author && typeof node.metadata.author === 'object'
      ? (node.metadata.author as {
          name?: string;
          email?: string;
          avatar?: string;
        })
      : null;

  return {
    id: node.id,
    filename: node.name,
    size: Number(node.size),
    mimeType: node.mimeType,
    isFolder: node.isFolder,
    starred: node.starred,
    parentId: node.parentId,
    spaceId: node.projectId || node.author?.id || node.authorId || null,
    projectId: node.projectId,
    url: getFileContentPath(node.id),
    thumbnail:
      typeof node.metadata?.thumbnail === 'string'
        ? node.metadata.thumbnail
        : null,
    metaData: node.metadata || {},
    trashedAt: node.trashedAt ? node.trashedAt.toISOString() : null,
    author: {
      id: node.author?.id || node.authorId,
      name:
        node.author?.name ||
        metadataAuthor?.name ||
        (typeof node.metadata?.authorName === 'string'
          ? node.metadata.authorName
          : '') ||
        node.author?.email ||
        '',
      email: node.author?.email || metadataAuthor?.email || '',
      avatar: node.author?.avatar || metadataAuthor?.avatar || '',
    },
    createdAt: node.createdAt
      ? node.createdAt.toISOString()
      : new Date().toISOString(),
    updatedAt: node.updatedAt
      ? node.updatedAt.toISOString()
      : new Date().toISOString(),
  };
}

export function buildPaginatedExperimentsResponse(
  result: { nodes: ExperimentNode[]; total: number },
  pagination: PaginationParams,
) {
  const files = (result.nodes || []).map((node) =>
    mapExperimentNodeToDto(node),
  );
  return {
    files,
    total: result.total,
    page: pagination.currentPage,
    limit: pagination.take,
    hasMore: pagination.skip + files.length < result.total,
  };
}
