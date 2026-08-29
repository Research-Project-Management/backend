import { PrismaService } from '../../../../core/database/prisma.service';
import {
  normalizeCanonicalUrl,
  validateUrlSecurity,
} from '../policies/ingestion.policy';
import { IngestionValidationException } from '../errors/ingestion.errors';
import { UrlCaptureConnector } from '../providers/url-capture.connector';
import { ConflictException, BadRequestException } from '@nestjs/common';

export interface PreparedUrlItem {
  deduplicated: boolean;
  existingItem?: any;
  canonicalUrl: string;
  itemData?: {
    title: string;
    url: string;
    fileUrl: string;
    abstract?: string;
    doi?: string;
    authors?: string[];
    creators?: any[];
    year?: number | null;
    publicationTitle?: string;
    journal?: string;
    publisher?: string;
    itemType?: string;
    tags?: string[];
  };
}

export async function prepareUrlIngestion(
  workspaceId: string,
  rawUrl: string | undefined,
  previewToken: string | undefined,
  overrides: Record<string, any> | undefined,
  prisma: PrismaService,
  urlConnector?: UrlCaptureConnector,
): Promise<PreparedUrlItem> {
  let targetUrl = rawUrl;
  let captured: any = null;

  // 1. If URL is not provided directly, lookup persistent preview record by token
  if (previewToken && urlConnector) {
    const tokenHash = urlConnector.hashToken(previewToken);
    let previewRecord: any = null;
    if (prisma.capturePreview?.findUnique) {
      previewRecord = await prisma.capturePreview.findUnique({
        where: { tokenHash },
      });
    }

    if (previewRecord) {
      if (previewRecord.workspaceId !== workspaceId) {
        throw new IngestionValidationException(
          'Preview token does not belong to this workspace',
        );
      }
      if (previewRecord.consumedAt) {
        throw new ConflictException('Preview token has already been consumed');
      }
      if (new Date() > new Date(previewRecord.expiresAt)) {
        throw new BadRequestException('Preview token has expired');
      }
      targetUrl = targetUrl || previewRecord.sourceUrl;
      captured = {
        title: previewRecord.canonicalMetadata?.title,
        ...previewRecord.canonicalMetadata,
      };
    } else {
      const verification = urlConnector.verifyPreviewToken(
        {
          title: overrides?.title || rawUrl || 'Document',
          url: rawUrl || '',
          itemType: overrides?.itemType || 'webpage',
        },
        previewToken,
        { workspaceId },
      );
      if (verification.valid) {
        captured = { title: overrides?.title || rawUrl };
      }
    }
  }

  const canonicalUrl = normalizeCanonicalUrl(targetUrl);
  if (!canonicalUrl) {
    throw new IngestionValidationException('A valid URL must be provided');
  }

  // 2. SSRF Security check
  validateUrlSecurity(canonicalUrl);

  // 3. Database-backed deduplication within workspace
  let existing: any = null;
  if (prisma.catalogItem?.findFirst) {
    existing = await prisma.catalogItem.findFirst({
      where: {
        workspaceId,
        fileUrl: canonicalUrl,
        deletedAt: null,
      },
      include: { attachments: true, contributors: true },
    });
  }

  if (existing) {
    return {
      deduplicated: true,
      existingItem: existing,
      canonicalUrl,
    };
  }

  // 4. Metadata resolution fallback if direct capture needed
  if (!captured && urlConnector) {
    try {
      captured = await urlConnector.captureFromUrl(canonicalUrl, {
        workspaceId,
      });
    } catch {
      captured = null;
    }
  }

  const meta = captured?.rawMetadata || captured?.metadata || captured || {};
  const rawCreators =
    overrides?.creators ||
    overrides?.authors ||
    captured?.creators ||
    meta.creators ||
    meta.authors ||
    [];

  const authors: string[] = rawCreators
    .map((c: any) => {
      if (typeof c === 'string') return c;
      if (c.lastName && c.firstName) return `${c.lastName}, ${c.firstName}`;
      return c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim();
    })
    .filter(Boolean);

  const creators = rawCreators.map((c: any, index: number) => ({
    creatorType: typeof c === 'object' ? c.creatorType || 'author' : 'author',
    firstName: typeof c === 'object' ? c.firstName || '' : '',
    lastName: typeof c === 'object' ? c.lastName || '' : '',
    fullName:
      typeof c === 'string'
        ? c
        : c.fullName || `${c.firstName || ''} ${c.lastName || ''}`.trim(),
    orderIndex: index,
  }));

  const itemData = {
    title: overrides?.title || captured?.title || meta.title || canonicalUrl,
    url: overrides?.url || captured?.url || canonicalUrl,
    fileUrl: canonicalUrl,
    abstract: overrides?.abstract || captured?.abstract || meta.abstract || '',
    doi: overrides?.doi || captured?.doi || meta.doi || undefined,
    arxivId:
      overrides?.arxivId || captured?.arxivId || meta.arxivId || undefined,
    authors: authors.length > 0 ? authors : undefined,
    creators: creators.length > 0 ? creators : undefined,
    year:
      overrides?.year ||
      (captured?.year || meta.year
        ? parseInt(String(captured?.year || meta.year), 10)
        : null),
    publicationDate:
      overrides?.publicationDate ||
      captured?.publicationDate ||
      meta.publicationDate ||
      undefined,
    publicationTitle:
      overrides?.publicationTitle ||
      overrides?.journal ||
      captured?.publicationTitle ||
      captured?.journal ||
      meta.publicationTitle ||
      meta.journal ||
      meta.siteName ||
      '',
    journal:
      overrides?.journal ||
      overrides?.publicationTitle ||
      captured?.journal ||
      captured?.publicationTitle ||
      meta.journal ||
      meta.publicationTitle ||
      '',
    publisher:
      overrides?.publisher ||
      captured?.publisher ||
      meta.publisher ||
      meta.siteName ||
      '',
    place: overrides?.place || captured?.place || meta.place || undefined,
    volume: overrides?.volume || captured?.volume || meta.volume || undefined,
    issue: overrides?.issue || captured?.issue || meta.issue || undefined,
    section:
      overrides?.section || captured?.section || meta.section || undefined,
    partNumber:
      overrides?.partNumber ||
      captured?.partNumber ||
      meta.partNumber ||
      undefined,
    partTitle:
      overrides?.partTitle ||
      captured?.partTitle ||
      meta.partTitle ||
      undefined,
    pages: overrides?.pages || captured?.pages || meta.pages || undefined,
    series: overrides?.series || captured?.series || meta.series || undefined,
    seriesTitle:
      overrides?.seriesTitle ||
      captured?.seriesTitle ||
      meta.seriesTitle ||
      undefined,
    seriesNumber:
      overrides?.seriesNumber ||
      captured?.seriesNumber ||
      meta.seriesNumber ||
      undefined,
    seriesText:
      overrides?.seriesText ||
      captured?.seriesText ||
      meta.seriesText ||
      undefined,
    issn: overrides?.issn || captured?.issn || meta.issn || undefined,
    isbn: overrides?.isbn || captured?.isbn || meta.isbn || undefined,
    pmid: overrides?.pmid || captured?.pmid || meta.pmid || undefined,
    pmcid: overrides?.pmcid || captured?.pmcid || meta.pmcid || undefined,
    journalAbbr:
      overrides?.journalAbbr ||
      captured?.journalAbbr ||
      meta.journalAbbr ||
      undefined,
    shortTitle:
      overrides?.shortTitle ||
      captured?.shortTitle ||
      meta.shortTitle ||
      undefined,
    rights:
      overrides?.rights ||
      overrides?.license ||
      captured?.rights ||
      captured?.license ||
      meta.rights ||
      meta.license ||
      undefined,
    license:
      overrides?.license ||
      overrides?.rights ||
      captured?.license ||
      captured?.rights ||
      meta.license ||
      meta.rights ||
      undefined,
    citationKey:
      overrides?.citationKey ||
      captured?.citationKey ||
      meta.citationKey ||
      undefined,
    archive:
      overrides?.archive || captured?.archive || meta.archive || undefined,
    archiveLocation:
      overrides?.archiveLocation ||
      captured?.archiveLocation ||
      meta.archiveLocation ||
      undefined,
    libraryCatalog:
      overrides?.libraryCatalog ||
      captured?.libraryCatalog ||
      meta.libraryCatalog ||
      undefined,
    callNumber:
      overrides?.callNumber ||
      captured?.callNumber ||
      meta.callNumber ||
      undefined,
    extra: overrides?.extra || captured?.extra || meta.extra || undefined,
    itemType:
      overrides?.itemType ||
      overrides?.type ||
      captured?.itemType ||
      meta.itemType ||
      'webpage',
    tags:
      overrides?.tags ||
      overrides?.keywords ||
      captured?.keywords ||
      meta.keywords ||
      [],
  };

  return {
    deduplicated: false,
    canonicalUrl,
    itemData,
  };
}
