import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { ArchiveEntryVo, ImportSummaryVo } from '../domain/archive.domain';
import {
  isBlockedSsrfUrl,
  MAX_SINGLE_FILE_BYTES,
  validateExtractedArchiveEntries,
} from '../domain/archive.policy';
import { resolveImportFormat } from '../domain/latex-import.domain';
import { PageArchiveHydratorAdapter } from '../adapters/hydrator.adapter';
import { ZipAdapter } from '../adapters/zip.adapter';
import { ImportSummaryResponseDto } from '../dto/import.dto';
import { ConvertService } from './convert.service';

const MAX_URL_IMPORT_BYTES = Math.min(25 * 1024 * 1024, MAX_SINGLE_FILE_BYTES);
const URL_FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECT_HOPS = 3;

@Injectable()
export class ImportService {
  private readonly zipEngine: ZipAdapter;

  constructor(
    private readonly hydrator: PageArchiveHydratorAdapter,
    @Optional() zipEngine?: ZipAdapter,
    @Optional() private readonly convertService?: ConvertService,
  ) {
    this.zipEngine = zipEngine ?? new ZipAdapter();
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), URL_FETCH_TIMEOUT_MS);

    try {
      const { response, finalUrl } = await this.fetchSsrfSafeResponse(
        url,
        controller.signal,
      );
      const buffer = await this.readBoundedResponseBody(response, controller);

      const safeName =
        (filename || finalUrl.pathname.split('/').pop() || 'imported-file.tex')
          .replace(/[^\w.-]/g, '_')
          .slice(0, 128) || 'imported-file.tex';

      await this.ingestFetchedPayload(spaceId, safeName, buffer, pageId, userId);

      return { filename: safeName, sizeBytes: buffer.length, imported: true };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Hop-by-hop redirect validation preventing HTTP 30x SSRF redirect bypasses.
   */
  private async fetchSsrfSafeResponse(
    initialUrl: string,
    signal: AbortSignal,
  ): Promise<{ response: Response; finalUrl: URL }> {
    let currentRaw = initialUrl;

    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
      const { parsed, reason } = isBlockedSsrfUrl(currentRaw);
      if (!parsed) {
        throw new BadRequestException(reason || 'Invalid URL.');
      }

      const response = await fetch(parsed.toString(), {
        signal,
        redirect: 'manual',
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          throw new BadRequestException(
            `Redirect response HTTP ${response.status} missing Location header.`,
          );
        }
        currentRaw = new URL(location, parsed).toString();
        continue;
      }

      if (!response.ok) {
        throw new BadRequestException(
          `Failed to fetch URL: HTTP ${response.status}`,
        );
      }

      return { response, finalUrl: parsed };
    }

    throw new BadRequestException('Too many HTTP redirects while fetching URL.');
  }

  /**
   * Streams response chunks with O(1) Content-Length fast-fail and incremental byte cap
   * to prevent OOM when remote URL serves multi-gigabyte payloads.
   */
  private async readBoundedResponseBody(
    response: Response,
    controller: AbortController,
  ): Promise<Buffer> {
    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader !== null) {
      const declaredLength = Number(contentLengthHeader);
      if (Number.isFinite(declaredLength) && declaredLength > MAX_URL_IMPORT_BYTES) {
        controller.abort();
        throw new BadRequestException('Fetched file exceeds 25 MB limit.');
      }
      if (declaredLength === 0) {
        controller.abort();
        throw new BadRequestException('Fetched file is empty.');
      }
    }

    if (!response.body) {
      const fallback = Buffer.from(await response.arrayBuffer());
      if (fallback.length === 0 || fallback.length > MAX_URL_IMPORT_BYTES) {
        throw new BadRequestException(
          'Fetched file is empty or exceeds 25 MB limit.',
        );
      }
      return fallback;
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;

        totalBytes += value.byteLength;
        if (totalBytes > MAX_URL_IMPORT_BYTES) {
          controller.abort();
          throw new BadRequestException('Fetched file exceeds 25 MB limit.');
        }

        chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
    } finally {
      reader.releaseLock();
    }

    if (totalBytes === 0) {
      throw new BadRequestException('Fetched file is empty.');
    }

    return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalBytes);
  }

  private async ingestFetchedPayload(
    spaceId: string,
    fileName: string,
    buffer: Buffer,
    pageId?: string,
    userId?: string,
  ): Promise<void> {
    if (fileName.toLowerCase().endsWith('.zip')) {
      await this.importProjectZip(spaceId, buffer, userId, undefined, pageId);
      return;
    }

    const convertibleFormat = resolveImportFormat(undefined, fileName);
    if (convertibleFormat && this.convertService) {
      await this.convertService.convertDocument({
        projectId: spaceId,
        fileBuffer: buffer,
        fileName,
        format: convertibleFormat,
        pageId,
        userId,
      });
      return;
    }

    const entry = ArchiveEntryVo.create(fileName, buffer, false);
    await this.hydrator.hydrateProjectEntries(
      spaceId,
      [entry],
      userId,
      undefined,
      pageId,
    );
  }
}
