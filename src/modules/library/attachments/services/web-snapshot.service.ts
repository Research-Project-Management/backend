import {
  Injectable,
  Logger,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import createDOMPurify from 'dompurify';
import { MetadataRoutingPolicy } from '../../ingestion/metadata/policies/metadata.policy';
import { AttachmentsService } from '../attachments.service';
import { R2Service } from '../../../storage/r2/r2.service';
import { SsrfGuardService } from '../../common/services/ssrf-guard.service';

export interface SnapshotResult {
  title: string;
  byline?: string;
  excerpt?: string;
  siteName?: string;
  textContent: string;
  htmlContent: string;
  sizeBytes: number;
  checksum: string;
}

export interface CaptureAndAttachOptions {
  title?: string;
  uploadedById?: string;
}

@Injectable()
export class WebSnapshotService {
  private readonly logger = new Logger(WebSnapshotService.name);
  private readonly userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 FluxResearchBot/1.0';
  private readonly ssrfGuard: SsrfGuardService;

  constructor(
    private readonly attachmentsService: AttachmentsService,
    @Optional() private readonly r2Service?: R2Service,
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

    // 1. Validate URL against SSRF attack vectors via SsrfGuardService
    await this.ssrfGuard.assertSafeUrl(canonicalUrl, { maxRedirects: 5 });

    // 2. Fetch raw HTML content safely with redirect validation and 10MB streaming size limit
    const timeoutMs = options?.timeoutMs ?? 15000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const MAX_SNAPSHOT_SIZE = 10 * 1024 * 1024; // 10MB max limit
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
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
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
    } catch (fetchErr: any) {
      if (fetchErr.name === 'AbortError') {
        throw new BadRequestException(
          `Request timed out while capturing ${canonicalUrl}`,
        );
      }
      if (
        fetchErr instanceof BadRequestException ||
        fetchErr?.name === 'ForbiddenException' ||
        fetchErr?.status === 400 ||
        fetchErr?.status === 403
      ) {
        throw fetchErr;
      }
      throw new BadRequestException(
        `Failed to fetch target URL for snapshot: ${fetchErr?.message || fetchErr}`,
      );
    } finally {
      clearTimeout(timer);
    }

    // 3. Parse with JSDOM and Mozilla Readability
    const dom = new JSDOM(rawHtml, { url: canonicalUrl });
    const DOMPurify = createDOMPurify(dom.window);
    const reader = new Readability(dom.window.document, {
      charThreshold: 20,
    });

    const parsedArticle = reader.parse();

    const title =
      parsedArticle?.title?.trim() ||
      options?.title?.trim() ||
      dom.window.document.title?.trim() ||
      'Web Snapshot';
    const byline = parsedArticle?.byline?.trim() || undefined;
    const excerpt = parsedArticle?.excerpt?.trim() || undefined;
    const siteName =
      parsedArticle?.siteName?.trim() || new URL(canonicalUrl).hostname;
    const textContent =
      parsedArticle?.textContent?.trim() ||
      dom.window.document.body?.textContent?.trim() ||
      '';

    // 4. Sanitize article body with DOMPurify
    const rawContent =
      parsedArticle?.content ||
      dom.window.document.body?.innerHTML ||
      '<p>No content captured</p>';
    const sanitizedBody = DOMPurify.sanitize(rawContent, {
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

    // 5. Build self-contained Reader-mode HTML document styled with Flux Flat UI theme
    const capturedAtIso = new Date().toISOString();
    const formattedDate = new Date().toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
    });

    const standaloneHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="Flux Research Platform - Web Snapshot">
  <meta name="source-url" content="${this.escapeHtml(canonicalUrl)}">
  <meta name="captured-at" content="${capturedAtIso}">
  <title>${this.escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #ffffff;
      --text: #18181b;
      --muted: #71717a;
      --border: #e4e4e7;
      --card: #fafafa;
      --accent: #2563eb;
      --code-bg: #f4f4f5;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #09090b;
        --text: #f4f4f5;
        --muted: #a1a1aa;
        --border: #27272a;
        --card: #18181b;
        --accent: #3b82f6;
        --code-bg: #27272a;
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 2rem 1.25rem;
      background-color: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Geist Sans", sans-serif;
      line-height: 1.65;
      font-size: 16px;
      -webkit-font-smoothing: antialiased;
    }
    .flux-container {
      max-width: 780px;
      margin: 0 auto;
    }
    .flux-badge-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem;
      padding: 0.75rem 1rem;
      background-color: var(--card);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-size: 12px;
      margin-bottom: 2rem;
    }
    .flux-badge-tag {
      background-color: var(--accent);
      color: #ffffff;
      font-weight: 600;
      padding: 0.15rem 0.5rem;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-size: 10px;
    }
    .flux-badge-source {
      color: var(--muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      min-width: 200px;
    }
    .flux-badge-source a {
      color: var(--accent);
      text-decoration: none;
    }
    .flux-badge-source a:hover {
      text-decoration: underline;
    }
    .flux-badge-time {
      color: var(--muted);
      font-size: 11px;
    }
    h1.flux-title {
      font-size: 2rem;
      font-weight: 700;
      line-height: 1.25;
      margin-top: 0;
      margin-bottom: 0.5rem;
      letter-spacing: -0.02em;
    }
    .flux-byline {
      color: var(--muted);
      font-size: 14px;
      margin-bottom: 2rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1rem;
    }
    article img {
      max-width: 100%;
      height: auto;
      border-radius: 6px;
      margin: 1.5rem 0;
    }
    article pre {
      background-color: var(--code-bg);
      padding: 1rem;
      border-radius: 6px;
      overflow-x: auto;
      font-family: ui-monospace, SFMono-Regular, "Geist Mono", monospace;
      font-size: 13px;
      border: 1px solid var(--border);
    }
    article code {
      background-color: var(--code-bg);
      padding: 0.2em 0.4em;
      border-radius: 4px;
      font-size: 0.9em;
      font-family: ui-monospace, SFMono-Regular, "Geist Mono", monospace;
    }
    article blockquote {
      margin: 1.5rem 0;
      padding-left: 1rem;
      border-left: 3px solid var(--accent);
      color: var(--muted);
      font-style: italic;
    }
    article table {
      width: 100%;
      border-collapse: collapse;
      margin: 1.5rem 0;
      font-size: 14px;
    }
    article th, article td {
      padding: 0.5rem 0.75rem;
      border: 1px solid var(--border);
      text-align: left;
    }
    article th {
      background-color: var(--card);
      font-weight: 600;
    }
    footer.flux-footer {
      margin-top: 4rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
      font-size: 12px;
      color: var(--muted);
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="flux-container">
    <div class="flux-badge-bar">
      <span class="flux-badge-tag">Offline Web Snapshot</span>
      <span class="flux-badge-source">
        Source: <a href="${this.escapeHtml(canonicalUrl)}" target="_blank" rel="noopener noreferrer">${this.escapeHtml(canonicalUrl)}</a>
      </span>
      <span class="flux-badge-time">Captured: ${formattedDate}</span>
    </div>

    <h1 class="flux-title">${this.escapeHtml(title)}</h1>
    ${byline ? `<div class="flux-byline">By ${this.escapeHtml(byline)} • ${this.escapeHtml(siteName)}</div>` : `<div class="flux-byline">${this.escapeHtml(siteName)}</div>`}

    <article>
      ${sanitizedBody}
    </article>

    <footer class="flux-footer">
      Archived by Flux Research Platform • Permanent snapshot preserved on ${formattedDate}.
    </footer>
  </div>
</body>
</html>`;

    const htmlBuffer = Buffer.from(standaloneHtml, 'utf-8');
    const checksum = createHash('sha256').update(htmlBuffer).digest('hex');

    return {
      title,
      byline,
      excerpt,
      siteName,
      textContent,
      htmlContent: standaloneHtml,
      sizeBytes: htmlBuffer.length,
      checksum,
    };
  }

  /**
   * Captures a web snapshot, uploads it to storage (S3/R2), and attaches it to the target Item.
   */
  async captureAndAttach(
    url: string,
    itemId: string,
    workspaceId: string,
    options?: CaptureAndAttachOptions,
  ): Promise<{ attachment: any; snapshot: SnapshotResult }> {
    this.logger.log(
      `Capturing web snapshot for item ${itemId} from ${url}`,
    );

    const snapshot = await this.captureHtmlSnapshot(url, {
      title: options?.title,
    });

    // 1. Upload to storage
    const sanitizedTitle = (snapshot.title || options?.title || 'web_page')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 40);

    const timestamp = Date.now();
    const fileKey = `${workspaceId}/library/snapshots/${itemId}_snapshot_${timestamp}.html`;
    const filename = `Snapshot_${sanitizedTitle}_${new Date().toISOString().slice(0, 10)}.html`;

    let fileUrl = `/api/files/snapshots/${fileKey}`;
    if (this.r2Service?.uploadBuffer) {
      try {
        const uploadResult = await this.r2Service.uploadBuffer(
          fileKey,
          Buffer.from(snapshot.htmlContent, 'utf-8'),
          'text/html; charset=utf-8',
        );
        fileUrl = uploadResult.url;
      } catch (err: any) {
        this.logger.warn(
          `Storage upload failed, using fallback URL: ${err?.message}`,
        );
      }
    }

    // 2. Attach to item
    const attachment = await this.attachmentsService.createAttachment({
      workspaceId,
      itemId,
      filename,
      url: fileUrl,
      mimeType: 'text/html',
      size: snapshot.sizeBytes,
      fileHash: snapshot.checksum,
    });

    this.logger.log(
      `Snapshot successfully attached to item ${itemId}: ${filename} (${(snapshot.sizeBytes / 1024).toFixed(1)} KB)`,
    );

    return { attachment, snapshot };
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
