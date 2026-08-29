import { PrismaService } from '../../../../core/database/prisma.service';
import {
  validatePdfBuffer,
  validateUrlSecurity,
  normalizeDoi,
} from '../policies/ingestion.policy';
import { normalizeTags } from '../metadata/metadata.identifiers';
import {
  IngestionValidationException,
  IngestionStorageException,
} from '../errors/ingestion.errors';
import { ExtractorService } from '../../attachments/providers/extractor.provider';
import { IStoragePort } from '../../../storage/storage.port';
import * as path from 'path';

export interface PreparedPdfItem {
  deduplicated: boolean;
  existingItem?: any;
  existingAttachmentId?: string;
  fileHash: string;
  sizeBytes: number;
  filename: string;
  fileUrl: string;
  fileId?: string;
  mimeType: string;
  extractedDoc?: any;
  itemData?: {
    title: string;
    doi?: string;
    abstract?: string;
    authors?: string[];
    creators?: any[];
    year?: number | null;
    publicationTitle?: string;
    journal?: string;
    itemType?: string;
    keywords?: string[];
    filename: string;
    fileUrl: string;
    mimeType: string;
    size: number;
  };
}

export async function preparePdfIngestion(
  workspaceId: string,
  command: {
    fileId: string;
    filename?: string;
    collectionId?: string;
    overrides?: Record<string, any>;
  },
  prisma: PrismaService,
  extractorService: ExtractorService,
  storagePort: IStoragePort,
): Promise<PreparedPdfItem> {
  const fileId = command.fileId;
  if (!fileId || typeof fileId !== 'string') {
    throw new IngestionValidationException(
      'A valid fileId belonging to the workspace must be provided for PDF ingestion',
    );
  }

  let storageFile;
  try {
    storageFile = await storagePort.readOwnedFile({ workspaceId, fileId });
  } catch (err: any) {
    if (err instanceof IngestionValidationException) {
      throw err;
    }
    if (
      err?.status === 404 ||
      err?.status === 403 ||
      err?.name === 'NotFoundException' ||
      err?.name === 'ForbiddenException'
    ) {
      throw new IngestionValidationException(
        err.message || `File ${fileId} not found or access denied in workspace`,
      );
    }
    throw new IngestionStorageException(
      `Failed reading file from storage service: ${err.message}`,
    );
  }

  const rawBuffer = storageFile.buffer;
  const filename = command.filename || storageFile.filename || 'document.pdf';
  const fileUrl = `/api/files/r2/${storageFile.fileId}`;
  const mimeType = storageFile.mimeType || 'application/pdf';

  // 2. Validate PDF magic bytes, size limits, and compute authentic SHA-256
  const { fileHash, sizeBytes } = validatePdfBuffer(rawBuffer);

  // 3. Database-backed deduplication claim check by SHA-256 in workspace
  if (prisma.libraryDedupClaim?.findUnique) {
    const claim = await prisma.libraryDedupClaim.findUnique({
      where: {
        workspaceId_claimType_claimValue: {
          workspaceId,
          claimType: 'pdf_sha256',
          claimValue: fileHash.toLowerCase().trim(),
        },
      },
      include: {
        catalogItem: {
          include: { attachments: true, contributors: true },
        },
      },
    });

    if (claim?.catalogItem && !claim.catalogItem.deletedAt) {
      return {
        deduplicated: true,
        existingItem: claim.catalogItem,
        existingAttachmentId: claim.catalogItem.attachments?.[0]?.id,
        fileHash,
        sizeBytes,
        filename,
        fileUrl: claim.catalogItem.attachments?.[0]?.url || fileUrl,
        fileId,
        mimeType,
      };
    }
  }

  let existingAttachment: any = null;
  if (prisma.catalogAttachment?.findFirst) {
    existingAttachment = await prisma.catalogAttachment.findFirst({
      where: {
        fileHash,
        catalogItem: {
          workspaceId,
          deletedAt: null,
        },
      },
      include: { catalogItem: true },
    });
  }

  if (existingAttachment && existingAttachment.catalogItem) {
    return {
      deduplicated: true,
      existingItem: existingAttachment.catalogItem,
      existingAttachmentId: existingAttachment.id,
      fileHash,
      sizeBytes,
      filename,
      fileUrl: existingAttachment.url || fileUrl,
      fileId,
      mimeType,
    };
  }

  // 4. Extraction outside transaction
  const extractedDoc =
    await extractorService.extractDocumentFromBuffer(rawBuffer);
  const meta: any = {
    ...extractedDoc.metadata,
    ...(command.overrides || {}),
  };

  const normalizedDoi = normalizeDoi(meta.doi);

  // If DOI was discovered in PDF, check for existing item with same DOI in workspace
  if (normalizedDoi) {
    if (prisma.libraryDedupClaim?.findUnique) {
      const doiClaim = await prisma.libraryDedupClaim.findUnique({
        where: {
          workspaceId_claimType_claimValue: {
            workspaceId,
            claimType: 'doi',
            claimValue: normalizedDoi,
          },
        },
        include: {
          catalogItem: {
            include: { attachments: true, contributors: true },
          },
        },
      });
      if (doiClaim?.catalogItem && !doiClaim.catalogItem.deletedAt) {
        return {
          deduplicated: true,
          existingItem: doiClaim.catalogItem,
          fileHash,
          sizeBytes,
          filename,
          fileUrl,
          fileId,
          mimeType,
        };
      }
    }

    let existingDoiItem: any = null;
    if (prisma.catalogItem?.findFirst) {
      existingDoiItem = await prisma.catalogItem.findFirst({
        where: {
          workspaceId,
          doi: normalizedDoi,
          deletedAt: null,
        },
        include: { attachments: true, contributors: true },
      });
    }

    if (existingDoiItem) {
      return {
        deduplicated: true,
        existingItem: existingDoiItem,
        fileHash,
        sizeBytes,
        filename,
        fileUrl,
        fileId,
        mimeType,
      };
    }
  }

  const authors: string[] = (meta.authors || [])
    .map((c: any) =>
      typeof c === 'string'
        ? c
        : c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    )
    .filter(Boolean);

  const creators = (meta.creators || meta.authors || []).map(
    (c: any, index: number) => ({
      creatorType: typeof c === 'object' ? c.creatorType || 'author' : 'author',
      firstName: typeof c === 'object' ? c.firstName || '' : '',
      lastName: typeof c === 'object' ? c.lastName || '' : '',
      fullName:
        typeof c === 'string'
          ? c
          : c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
      orderIndex: index,
    }),
  );

  const rawKeywords = [
    ...(Array.isArray(meta.keywords) ? meta.keywords : []),
    ...(Array.isArray(meta.tags) ? meta.tags : []),
  ];
  const normalizedKeywords = normalizeTags(rawKeywords);

  const itemData = {
    title: meta.title || filename.replace(/\.[^/.]+$/, ''),
    doi: normalizedDoi || undefined,
    abstract: meta.abstract || '',
    authors: authors.length > 0 ? authors : undefined,
    creators: creators.length > 0 ? creators : undefined,
    year: meta.year ? parseInt(String(meta.year), 10) : null,
    publicationTitle: meta.publicationTitle || meta.journal || '',
    journal: meta.journal || meta.publicationTitle || '',
    itemType: meta.itemType || 'journalArticle',
    keywords: normalizedKeywords,
    tags: normalizedKeywords,
    filename,
    fileUrl: fileUrl || `/files/${fileHash}`,
    mimeType,
    size: sizeBytes,
  };

  return {
    deduplicated: false,
    fileHash,
    sizeBytes,
    filename,
    fileUrl: itemData.fileUrl,
    fileId,
    mimeType,
    extractedDoc,
    itemData,
  };
}
