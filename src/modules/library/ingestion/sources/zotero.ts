import { PrismaService } from '../../../../core/database/prisma.service';
import { IngestionValidationException } from '../errors/ingestion.errors';
import { normalizeDoi } from '../policies/ingestion.policy';

export interface PreparedZoteroItem {
  deduplicated: boolean;
  existingItem?: any;
  bindingId: string;
  itemData?: {
    title: string;
    doi?: string;
    abstract?: string;
    authors?: string[];
    creators?: any[];
    year?: number | null;
    publicationTitle?: string;
    journal?: string;
    publisher?: string;
    itemType?: string;
    extra?: string;
  };
}

export async function prepareZoteroIngestion(
  workspaceId: string,
  connectionId: string,
  externalItemKey: string,
  payload: any,
  prisma: PrismaService,
): Promise<PreparedZoteroItem> {
  if (!connectionId || !externalItemKey) {
    throw new IngestionValidationException(
      'connectionId and externalItemKey must be provided for Zotero ingestion',
    );
  }

  // 1. Verify connection or binding exists in workspace
  let binding: any = null;
  if (prisma.zoteroBinding?.findFirst) {
    binding = await prisma.zoteroBinding.findFirst({
      where: {
        workspaceId,
        OR: [{ id: connectionId }, { connectionId }],
      },
    });
  }

  const validBindingId = binding ? binding.id : connectionId;

  // 2. Database-backed deduplication by binding + external item key
  let existingItemBinding: any = null;
  if (prisma.zoteroItemBinding?.findFirst) {
    existingItemBinding = await prisma.zoteroItemBinding.findFirst({
      where: {
        workspaceId,
        bindingId: validBindingId,
        remoteKey: externalItemKey,
      },
    });
  }

  if (
    existingItemBinding &&
    existingItemBinding.entityId &&
    prisma.catalogItem?.findUnique
  ) {
    const existingItem = await prisma.catalogItem.findUnique({
      where: { id: existingItemBinding.entityId },
      include: { attachments: true },
    });

    if (existingItem) {
      return {
        deduplicated: true,
        existingItem,
        bindingId: validBindingId,
      };
    }
  }

  // 3. Format payload
  const zData = payload?.data || payload || {};
  const normalizedDoi = normalizeDoi(zData.DOI || zData.doi);

  const creators = (zData.creators || []).map((c: any, index: number) => ({
    creatorType: c.creatorType || 'author',
    firstName: c.firstName || '',
    lastName: c.lastName || '',
    fullName:
      typeof c === 'string'
        ? c
        : c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    orderIndex: index,
  }));

  const authors: string[] = creators
    .map((c: any) => c.fullName)
    .filter(Boolean);

  let year: number | null = null;
  if (zData.date) {
    const match = String(zData.date).match(/\b(19|20)\d{2}\b/);
    if (match) {
      year = parseInt(match[0], 10);
    }
  }

  const itemData = {
    title: zData.title || `Zotero Item (${externalItemKey})`,
    doi: normalizedDoi || undefined,
    abstract: zData.abstractNote || zData.abstract || '',
    authors: authors.length > 0 ? authors : undefined,
    creators: creators.length > 0 ? creators : undefined,
    year,
    publicationTitle: zData.publicationTitle || zData.journalAbbreviation || '',
    journal: zData.publicationTitle || zData.journalAbbreviation || '',
    publisher: zData.publisher || '',
    itemType: zData.itemType || 'journalArticle',
    extra: zData.extra || `Zotero Key: ${externalItemKey}`,
  };

  return {
    deduplicated: false,
    bindingId: validBindingId,
    itemData,
  };
}
