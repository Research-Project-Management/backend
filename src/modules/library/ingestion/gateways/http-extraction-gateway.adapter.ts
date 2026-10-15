import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IExtractionGatewayPort } from '@/modules/library/ingestion/types/extraction-gateway.types';
import { ResilienceRegistryService } from '@/modules/library/shared-kernel/resilience/resilience-registry.service';

/**
 * Remote HTTP Adapter connecting Ingestion to standalone Extraction Microservice.
 * Follows S3 Claim-Check pattern: heavy document buffers are offloaded or posted via multipart/form-data.
 */
@Injectable()
export class HttpExtractionGatewayAdapter implements IExtractionGatewayPort {
  private readonly logger = new Logger(HttpExtractionGatewayAdapter.name);

  constructor(
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly resilienceRegistry?: ResilienceRegistryService,
  ) {}

  private getBaseUrl(): string {
    return (
      this.configService?.get<string>('LIBRARY_EXTRACTION_URL') ||
      process.env.LIBRARY_EXTRACTION_URL ||
      'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  async extractDocumentFromBuffer<T = unknown>(
    buffer: Buffer,
    options?: Record<string, unknown>,
  ): Promise<T | null> {
    const baseUrl = this.getBaseUrl();
    const url = `${baseUrl}/api/v1/library/storage/extract`;

    try {
      const blob = new Blob([new Uint8Array(buffer)]);
      const formData = new FormData();
      formData.append('file', blob, 'document.pdf');
      if (options) {
        formData.append('options', JSON.stringify(options));
      }

      const res = await fetch(url, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        this.logger.warn(
          `Extraction service returned ${res.status}: ${res.statusText}`,
        );
        return null;
      }

      const json = (await res.json()) as { data?: T } & T;
      return json?.data ?? json;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Document buffer extraction failed: ${message}`);
      return null;
    }
  }

  async extractTrustedMetadata<T = unknown>(
    buffer: Buffer,
    preferredFilename?: string,
  ): Promise<T | null> {
    const result = await this.extractDocumentFromBuffer<{ metadata?: unknown }>(
      buffer,
      { preferredFilename },
    );
    return result?.metadata
      ? ({
          metadata: result.metadata,
          quality: { totalScore: 0.95 },
        } as unknown as T)
      : null;
  }

  async extractMetadataFromBuffer<T = unknown>(
    buffer: Buffer,
  ): Promise<T | null> {
    const result = await this.extractDocumentFromBuffer<{ metadata?: T }>(
      buffer,
    );
    return result?.metadata ?? null;
  }

  async captureWebSnapshot<T = unknown>(
    url: string,
    itemId: string,
    userId: string,
  ): Promise<T | null> {
    const baseUrl = this.getBaseUrl();
    const targetUrl = `${baseUrl}/api/v1/library/attachments/snapshot`;

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'x-user-id': userId,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url, itemId }),
      });

      if (!res.ok) return null;
      const json = (await res.json()) as { data?: T } & T;
      return json?.data ?? json;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Web snapshot capture failed: ${message}`);
      return null;
    }
  }

  async createAttachment<T = unknown, D = Record<string, unknown>>(
    data: D,
    projectId?: string,
  ): Promise<T | null> {
    const baseUrl = this.getBaseUrl();
    const targetUrl = projectId
      ? `${baseUrl}/api/v1/projects/${projectId}/library/attachments`
      : `${baseUrl}/api/v1/library/attachments`;

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!res.ok)
        throw new Error(`Create attachment failed: ${res.statusText}`);
      const json = (await res.json()) as { data?: T } & T;
      return json?.data ?? json;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Attachment creation failed: ${message}`);
      return null;
    }
  }

  async createNote<T = unknown, D = Record<string, unknown>>(
    userId: string,
    data: D,
  ): Promise<T | null> {
    const baseUrl = this.getBaseUrl();
    const targetUrl = `${baseUrl}/api/v1/library/notes`;

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'x-user-id': userId, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!res.ok) return null;
      const json = (await res.json()) as { data?: T } & T;
      return json?.data ?? json;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Note creation failed: ${message}`);
      return null;
    }
  }

  async reassignContentToItem(
    duplicateItemIds: string[],
    primaryItemId: string,
    _tx?: unknown,
  ): Promise<void> {
    const baseUrl = this.getBaseUrl();
    const targetUrl = `${baseUrl}/api/v1/library/attachments/reassign`;

    try {
      await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duplicateItemIds, primaryItemId }),
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Content reassignment warning: ${message}`);
    }
  }
}
