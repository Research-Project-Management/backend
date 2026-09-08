import { NotFoundException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

export const isWorkspaceUuid = isUuid;

/**
 * Builds a workspace lookup without ever comparing a non-UUID identifier to
 * the UUID primary-key column. PostgreSQL rejects that comparison before it
 * can evaluate the remaining OR branches.
 */
export function buildWorkspaceIdentifierWhere(
  identifier: string,
): Prisma.WorkspaceWhereInput {
  if (isWorkspaceUuid(identifier)) {
    return { id: identifier, deletedAt: null };
  }

  return {
    OR: [
      { slug: { equals: identifier, mode: 'insensitive' } },
      { url: { equals: identifier, mode: 'insensitive' } },
    ],
    deletedAt: null,
  };
}

/**
 * Total TypeScript Utility: resolveTenantWorkspaceId
 * Resolves a workspace identifier (UUID, slug, or vanity URL) to its canonical Workspace ID.
 *
 * Fast-path optimization:
 * If the input is already a canonical UUID format, returns immediately without issuing
 * any database query. This eliminates redundant round-trip queries in request pipelines.
 */
export async function resolveTenantWorkspaceId(
  prisma: PrismaService | undefined,
  workspaceId: string,
): Promise<string> {
  if (!workspaceId || typeof workspaceId !== 'string' || !workspaceId.trim()) {
    throw new BadRequestException('Workspace identifier is required');
  }

  // Fast-path: return immediately if already a valid UUID
  if (isWorkspaceUuid(workspaceId)) {
    return workspaceId;
  }

  // If no prisma client or workspace model available, return as-is
  if (!prisma?.workspace?.findFirst) {
    return workspaceId;
  }

  const ws = await prisma.workspace.findFirst({
    where: buildWorkspaceIdentifierWhere(workspaceId),
    select: { id: true },
  });

  if (!ws) {
    throw new NotFoundException('Workspace not found');
  }

  return ws.id;
}
