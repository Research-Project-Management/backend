import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { ArchiveEntryVo, ImportSummaryVo } from '../domain/archive.domain';
import {
  isBlockedSsrfUrl,
  MAX_SINGLE_FILE_BYTES,
  validateExtractedArchiveEntries,
} from '../domain/archive.policy';
import {
  IPageArchiveHydratorPort,
  IZipEnginePort,
} from '../domain/archive.ports';
import { resolveImportFormat } from '../domain/latex-import.domain';
import { ZipAdapter } from '../adapters/zip.adapter';
import { ImportSummaryResponseDto } from '../dto/import.dto';
import { ConvertService } from './convert.service';

const MAX_URL_IMPORT_BYTES = Math.min(25 * 1024 * 1024, MAX_SINGLE_FILE_BYTES);
const URL_FETCH_TIMEOUT_MS = 15_000;

interface UrlPayloadContext {
  spaceId: string;
  fileName: string;
  buffer: Buffer;
  pageId?: string;
  userId?: string;
}

/**
 * GoF Strategy + Chain of Responsibility: Polymorphic ingestion of fetched URL payloads
 * (`.zip` archive -> convertible `.docx/.md/.markdown` -> raw single file/doc).
 */
interface IUrlPayloadIngestor {
  canIngest(fileName: string): boolean;
  ingest(ctx: UrlPayloadContext): Promise<void>;
}

@Injectable()
export class ImportService {
  private readonly zipEngine: IZipEnginePort;
  private readonly urlIngestors: ReadonlyArray<IUrlPayloadIngestor>;

  constructor(
    private readonly hydrator: IPageArchiveHydratorPort,
    @Optional() zipEngine?: IZipEnginePort,
    @Optional() private readonly convertService?: ConvertService,
  ) {
    this.zipEngine = zipEngine ?? new ZipAdapter();
    this.urlIngestors = [
      {
        canIngest: (fileName) => fileName.toLowerCase().endsWith('.zip'),
        ingest: async (ctx) => {
          await this.importProjectZip(
            ctx.spaceId,
            ctx.buffer,
            ctx.userId,
            undefined,
            ctx.pageId,
          );
        },
      },
      {
        canIngest: (fileName) =>
          Boolean(this.convertService && resolveImportFormat(undefined, fileName)),
        ingest: async (ctx) => {
          const format = resolveImportFormat(undefined, ctx.fileName);
          if (!this.convertService || !format) return;
          await this.convertService.convertDocument({
            projectId: ctx.spaceId,
            fileBuffer: ctx.buffer,
            fileName: ctx.fileName,
            format,
            pageId: ctx.pageId,
            userId: ctx.userId,
          });
        },
      },
      {
        canIngest: () => true,
        ingest: async (ctx) => {
          const entry = ArchiveEntryVo.create(ctx.fileName, ctx.buffer, false);
          await this.hydrator.hydrateProjectEntries(
            ctx.spaceId,
            [entry],
            ctx.userId,
            undefined,
            ctx.pageId,
          );
        },
      },
    ];
  }

  public async hydrateProjectEntries(
    projectId: string,
    entries: ArchiveEntryVo[],
    userId?: string | null,
    preferredRootDoc?: string,
    pageId?: string,
  ): Promise<ImportSummaryVo> {
    return this.hydrator.hydrateProjectEntries(
      projectId,
      entries,
      userId,
      preferredRootDoc,
      pageId,
    );
  }

  public async importProjectZip(
    projectId: string,
    zipBuffer: Buffer,
    userId?: string | null,
    preferredRootDoc?: string,
    pageId?: string,
  ): Promise<ImportSummaryResponseDto> {
    const entries = validateExtractedArchiveEntries(
      this.zipEngine.extractZip(zipBuffer),
    );
    const summary = await this.hydrator.hydrateProjectEntries(
      projectId,
      entries,
      userId,
      preferredRootDoc,
      pageId,
    );
    return summary.toJSON();
  }

  public async importFromUrl(
    spaceId: string,
    url: string,
    filename?: string,
    pageId?: string,
    userId?: string,
  ): Promise<{ filename: string; sizeBytes: number; imported: boolean }> {
    const { parsed, reason } = isBlockedSsrfUrl(url);
    if (!parsed) {
      throw new BadRequestException(reason || 'Invalid URL.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(parsed.toString(), {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new BadRequestException(
          `Failed to fetch URL: HTTP ${response.status}`,
        );
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_URL_IMPORT_BYTES) {
        throw new BadRequestException(
          'Fetched file is empty or exceeds 25 MB limit.',
        );
      }

      const safeName =
        (filename || parsed.pathname.split('/').pop() || 'imported-file.tex')
          .replace(/[^\w.-]/g, '_')
          .slice(0, 128) || 'imported-file.tex';

      const ingestor = this.urlIngestors.find((s) => s.canIngest(safeName));
      if (ingestor) {
        await ingestor.ingest({
          spaceId,
          fileName: safeName,
          buffer,
          pageId,
          userId,
        });
      }

      return { filename: safeName, sizeBytes: buffer.length, imported: true };
    } finally {
      clearTimeout(timeout);
    }
  }
}
