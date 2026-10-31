import {
  Injectable,
  Logger,
  BadRequestException,
  Optional,
  Inject,
} from '@nestjs/common';
import type { Attachment } from '@prisma/client';
import { createHash } from 'crypto';
import { AttachmentsService } from './attachments.service';
import { STORAGE_PORT, IStoragePort } from '@/modules/storage/storage.port';
import { SsrfGuardService } from '@/modules/library/core/services/ssrf-guard.service';
import { ExternalProviderException } from '@/modules/library/core/errors/domain.exception';
import { AttachmentStorageException } from '@/modules/library/extraction/types/attachments.types';
import { buildStandaloneSnapshotHtml } from '@/modules/library/extraction/extractors/snapshot-template.helper';

export interface SnapshotResult {
  title: string;
  byline?: string;
  excerpt?: string;
  siteName?: string;
  capturedAt?: string;
  textContent: string;
  htmlContent: string;
  sizeBytes: number;
  checksum: string;
}

export interface CaptureAndAttachOptions {
  title?: string;
  uploadedById?: string;
  projectId?: string;
}

@Injectable()
export class WebSnapshotService {
  private readonly logger = new Logger(WebSnapshotService.name);
  private readonly userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 FluxResearchBot/1.0';
  private readonly ssrfGuard: SsrfGuardService;

  constructor(
    private readonly attachmentsService: AttachmentsService,
    @Optional()
    @Inject(STORAGE_PORT)
    private readonly storagePort?: IStoragePort,
    @Optional() ssrfGuard?: SsrfGuardService,
  ) {
    this.ssrfGuard = ssrfGuard || new SsrfGuardService();
  }

  /**
   * Captures and cleans a web page using @mozilla/readability and DOMPurify.
   * Produces a self-contained, sanitized HTML snapshot document.
   */
  async captureHtmlSnapshot(
    url: string,
    options?: { title?: string; timeoutMs?: number },
  ): Promise<SnapshotResult> {
    const canonicalUrl = url.trim();

    await this.ssrfGuard.assertSafeUrl(canonicalUrl, { maxRedirects: 5 });

    const timeoutMs = options?.timeoutMs ?? 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const MAX_SNAPSHOT_SIZE = 10 * 1024 * 1024;
    let rawHtml = '';
    try {
      const response = await this.ssrfGuard.safeFetch(
        canonicalUrl,
        {
          headers: {
            'User-Agent': this.userAgent,
            Accept:
              'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          },
          signal: controller.signal,
        },
        { maxRedirects: 5 },
      );

      if (!response.ok) {
        throw new ExternalProviderException(
          `WebSnapshot failed: HTTP ${response.status} ${response.statusText}`,
          { provider: 'WebSnapshot', status: response.status },
        );
      }

      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > MAX_SNAPSHOT_SIZE) {
        throw new BadRequestException(
          `Target document size exceeds 10MB limit (${contentLength} bytes)`,
        );
      }

      const bodyStream = response.body;
      if (bodyStream) {
        const reader = bodyStream.getReader();
        const chunks: Uint8Array[] = [];
        let bytesRead = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            bytesRead += value.length;
            if (bytesRead > MAX_SNAPSHOT_SIZE) {
              await reader.cancel();
              throw new BadRequestException(
                'Target document size exceeds 10MB limit',
              );
            }
            chunks.push(value);
          }
        }
        rawHtml = Buffer.concat(chunks).toString('utf-8');
      } else {
        rawHtml = await response.text();
      }
    } catch (fetchErr: unknown) {
      if (fetchErr instanceof Error && fetchErr.name === 'AbortError') {
        throw new BadRequestException(
          `Request timed out while capturing ${canonicalUrl}`,
        );
      }
      if (
        fetchErr instanceof BadRequestException ||
        (fetchErr instanceof Error && fetchErr.name === 'ForbiddenException') ||
        (typeof fetchErr === 'object' &&
          fetchErr !== null &&
          'status' in fetchErr &&
          (fetchErr.status === 400 || fetchErr.status === 403))
      ) {
        throw fetchErr;
      }
      const message =
        fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      throw new BadRequestException(
        `Failed to fetch target URL for snapshot: ${message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    interface JsDomWindow {
      document: {
        title?: string;
        body?: { textContent?: string | null; innerHTML?: string };
      };
      close?: () => void;
    }
    interface JsDomInstance {
      window: JsDomWindow;
    }
    interface ReadabilityArticle {
      title?: string | null;
      byline?: string | null;
      excerpt?: string | null;
      siteName?: string | null;
      textContent?: string | null;
      content?: string | null;
    }
    interface ReadabilityInstance {
      parse(): ReadabilityArticle | null;
    }
    interface DomPurifyInstance {
      sanitize(html: string, config?: Record<string, unknown>): string;
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { JSDOM } = require('jsdom') as {
      JSDOM: new (html: string, options?: { url?: string }) => JsDomInstance;
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Readability } = require('@mozilla/readability') as {
      Readability: new (
        doc: JsDomWindow['document'],
        options?: { charThreshold?: number },
      ) => ReadabilityInstance;
    };
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const createDOMPurify = require('dompurify') as (
      win: JsDomWindow,
    ) => DomPurifyInstance;

    let title = 'Web Snapshot';
    let byline: string | undefined;
    let excerpt: string | undefined;
    let siteName = new URL(canonicalUrl).hostname;
    let textContent = '';
    let sanitizedBody = '<p>No content captured</p>';

    const dom = new JSDOM(rawHtml, { url: canonicalUrl });
    try {
      const DOMPurify = createDOMPurify(dom.window);
      const reader = new Readability(dom.window.document, {
        charThreshold: 20,
      });

      const parsedArticle = reader.parse();

      title =
        parsedArticle?.title?.trim() ||
        options?.title?.trim() ||
        dom.window.document.title?.trim() ||
        'Web Snapshot';
      byline = parsedArticle?.byline?.trim() || undefined;
      excerpt = parsedArticle?.excerpt?.trim() || undefined;
      siteName =
        parsedArticle?.siteName?.trim() || new URL(canonicalUrl).hostname;
      textContent =
        parsedArticle?.textContent?.trim() ||
        dom.window.document.body?.textContent?.trim() ||
        '';

      const rawContent =
        parsedArticle?.content ||
        dom.window.document.body?.innerHTML ||
        '<p>No content captured</p>';
      sanitizedBody = DOMPurify.sanitize(rawContent, {
        FORBID_TAGS: [
          'script',
          'iframe',
          'object',
          'embed',
          'form',
          'input',
          'button',
          'dialog',
        ],
        FORBID_ATTR: [
          'onerror',
          'onload',
          'onclick',
          'onmouseover',
          'onfocus',
          'onblur',
        ],
        ADD_TAGS: ['math', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac'],
      });
    } finally {
      try {
        if (typeof dom.window.close === 'function') {
          dom.window.close();
        }
      } catch {
        // ignore
      }
    }

    const capturedAtIso = new Date().toISOString();
    const formattedDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });

    const standaloneHtml = buildStandaloneSnapshotHtml({
      canonicalUrl,
      capturedAtIso,
      formattedDate,
      title,
      byline,
      siteName,
      sanitizedBody,
    });

    const htmlBuffer = Buffer.from(standaloneHtml, 'utf-8');
    const checksum = createHash('sha256').update(htmlBuffer).digest('hex');

    return {
      title,
      byline,
      excerpt,
      siteName,
      capturedAt: capturedAtIso,
      textContent,
      htmlContent: standaloneHtml,
      sizeBytes: htmlBuffer.length,
      checksum,
    };
  }

  async captureAndAttach(
    url: string,
    itemId: string,
    userId: string,
    options?: CaptureAndAttachOptions,
  ): Promise<{
    attachment: Awaited<ReturnType<AttachmentsService['createAttachment']>>;
    snapshot: SnapshotResult;
  }> {
    this.logger.log(`Capturing web snapshot for item ${itemId} from ${url}`);

    const snapshot = await this.captureHtmlSnapshot(url, {
      title: options?.title,
    });

    const sanitizedTitle = (snapshot.title || options?.title || 'web_page')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 40);

    const timestamp = Date.now();
    const fileKey = `${userId}/library/snapshots/${itemId}_snapshot_${timestamp}.html`;
    const filename = `Snapshot_${sanitizedTitle}_${new Date().toISOString().slice(0, 10)}.html`;

    if (!this.storagePort?.uploadFile && !this.storagePort?.uploadBuffer) {
      throw new AttachmentStorageException(
        'Failed to store web snapshot in storage: Storage provider is not configured',
      );
    }

    let fileUrl = '';
    let resolvedFileId: string | undefined;
    let uploaded = false;
    let lastUploadError: unknown;
    const buffer = Buffer.from(snapshot.htmlContent, 'utf-8');

    if (this.storagePort?.uploadFile) {
      try {
        const uploadResult = await this.storagePort.uploadFile({
          userId,
          filename,
          buffer,
          mimeType: 'text/html; charset=utf-8',
          source: 'library_snapshot',
        });
        fileUrl = uploadResult.url;
        resolvedFileId = uploadResult.fileId;
        uploaded = true;
      } catch (err: unknown) {
        lastUploadError = err;
        const message = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Storage uploadFile failed, falling back to uploadBuffer: ${message}`,
        );
      }
    }

    if (!uploaded && this.storagePort?.uploadBuffer) {
      try {
        const uploadResult = await this.storagePort.uploadBuffer(
          fileKey,
          buffer,
          'text/html; charset=utf-8',
        );
        fileUrl = uploadResult.url;
        uploaded = true;
      } catch (err: unknown) {
        lastUploadError = err;
      }
    }

    if (!uploaded || !fileUrl) {
      const message =
        lastUploadError instanceof Error
          ? lastUploadError.message
          : String(lastUploadError || 'Storage upload failed');
      throw new AttachmentStorageException(
        `Failed to store web snapshot in storage: ${message}`,
      );
    }

    const capturedAtIso = snapshot.capturedAt ?? new Date().toISOString();
    const createPayload = {
      userId,
      itemId,
      filename,
      url: fileUrl,
      fileId: resolvedFileId,
      mimeType: 'text/html',
      size: snapshot.sizeBytes,
      fileHash: snapshot.checksum,
      linkMode: 'imported_url' as const,
      attachmentType: 'snapshot' as const,
      metadata: {
        snapshotUrl: url,
        siteName: snapshot.siteName,
        byline: snapshot.byline,
        excerpt: snapshot.excerpt,
        capturedAt: capturedAtIso,
      },
    };
    const attachment = options?.projectId
      ? await this.attachmentsService.createAttachment(
          createPayload,
          options.projectId,
        )
      : await this.attachmentsService.createAttachment(createPayload);

    this.logger.log(
      `Snapshot successfully attached to item ${itemId}: ${filename} (${(snapshot.sizeBytes / 1024).toFixed(1)} KB)`,
    );

    return { attachment, snapshot };
  }
}
