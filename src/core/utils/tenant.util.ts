import { PrismaService } from '../database/prisma.service';

const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
  if (!workspaceId) return workspaceId;

  // Fast-path: return immediately if already a valid UUID
  if (UUID_REGEX.test(workspaceId)) {
    return workspaceId;
  }

  // If no prisma client or workspace model available, return as-is
  if (!prisma?.workspace?.findFirst) {
    return workspaceId;
  }

  try {
    const ws = await prisma.workspace.findFirst({
      where: {
        OR: [
          { id: workspaceId },
          { slug: workspaceId },
          { url: workspaceId },
          { slug: { equals: workspaceId, mode: 'insensitive' } },
        ],
        deletedAt: null,
      },
      select: { id: true },
    });
    return ws?.id ?? workspaceId;
  } catch {
    return workspaceId;
  }
}
