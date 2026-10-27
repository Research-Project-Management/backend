import { Prisma } from '@prisma/client';
import { PrismaService } from '@/core';
import { isUuid } from './creator-tag-payload.builder';

/**
 * Automatically disambiguates citation keys against existing items in the project or user scope.
 * Follows BibTeX / BetterBibTeX convention: vaswani2017attention -> vaswani2017attentiona -> vaswani2017attentionb.
 */
export async function disambiguateCitationKey(
  client:
    | Prisma.TransactionClient
    | PrismaService
    | { item?: { findMany?: Prisma.TransactionClient['item']['findMany'] } }
    | null
    | undefined,
  baseKey: string | null | undefined,
  scope: { userId: string; projectId?: string | null },
  excludeItemId?: string,
): Promise<string | null> {
  if (!baseKey || !baseKey.trim()) return null;
  const cleanKey = baseKey.trim();

  // Defensive fallback if client is a minimal mock in unit tests
  if (!client?.item?.findMany) {
    return cleanKey;
  }

  const scopeWhere: Prisma.ItemWhereInput =
    scope.projectId && isUuid(scope.projectId)
      ? { projectId: scope.projectId }
      : { userId: scope.userId, projectId: null };

  const existing = await client.item.findMany({
    where: {
      ...scopeWhere,
      deletedAt: null,
      ...(excludeItemId ? { id: { not: excludeItemId } } : {}),
      citationKey: { startsWith: cleanKey },
    },
    select: { citationKey: true },
  });

  const existingKeys = new Set(
    existing
      .map((item: { citationKey?: string | null }) => item.citationKey?.toLowerCase())
      .filter((k: string | undefined): k is string => Boolean(k)),
  );

  if (!existingKeys.has(cleanKey.toLowerCase())) {
    return cleanKey;
  }

  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < alphabet.length; i++) {
    const candidate = `${cleanKey}${alphabet[i]}`;
    if (!existingKeys.has(candidate.toLowerCase())) {
      return candidate;
    }
  }

  let counter = 1;
  while (existingKeys.has(`${cleanKey}-${counter}`.toLowerCase())) {
    counter++;
  }
  return `${cleanKey}-${counter}`;
}

export { disambiguateCitationKey as disambiguate };
