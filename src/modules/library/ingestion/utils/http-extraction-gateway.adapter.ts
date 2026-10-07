import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EXTRACTION_GATEWAY_PORT,
  IExtractionGatewayPort,
} from '../types/extraction-gateway.types';
import { ResilienceRegistryService } from '../../shared-kernel/resilience/resilience-registry.service';

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

  async extractDocumentFromBuffer(buffer: Buffer, options?: any): Promise<any> {
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

      const json = await res.json();
      return json?.data ?? json;
    } catch (err: any) {
      this.logger.error(
        `Document buffer extraction failed: ${err?.message || err}`,
      );
      return null;
    }
  }

  async extractMetadataFromBuffer(buffer: Buffer): Promise<any> {
    const result = await this.extractDocumentFromBuffer(buffer);
    return result?.metadata ?? null;
  }

  async captureWebSnapshot(
    url: string,
    itemId: string,
    userId: string,
  ): Promise<any> {
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
      const json = await res.json();
      return json?.data ?? json;
    } catch (err: any) {
      this.logger.error(`Web snapshot capture failed: ${err?.message || err}`);
      return null;
    }
  }

  async createAttachment(data: any, projectId?: string): Promise<any> {
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
      const json = await res.json();
      return json?.data ?? json;
    } catch (err: any) {
      this.logger.error(`Attachment creation failed: ${err?.message || err}`);
      return null;
    }
  }

  async createNote(userId: string, data: any): Promise<any> {
    const baseUrl = this.getBaseUrl();
    const targetUrl = `${baseUrl}/api/v1/library/notes`;

    try {
      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'x-user-id': userId, 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });

      if (!res.ok) return null;
      const json = await res.json();
      return json?.data ?? json;
    } catch (err: any) {
      this.logger.error(`Note creation failed: ${err?.message || err}`);
      return null;
    }
  }

  async reassignContentToItem(
    duplicateItemIds: string[],
    primaryItemId: string,
    tx?: any,
  ): Promise<void> {
    const baseUrl = this.getBaseUrl();
    const targetUrl = `${baseUrl}/api/v1/library/attachments/reassign`;

    try {
      await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duplicateItemIds, primaryItemId }),
      });
    } catch (err: any) {
      this.logger.warn(`Content reassignment warning: ${err?.message || err}`);
    }
  }
}
