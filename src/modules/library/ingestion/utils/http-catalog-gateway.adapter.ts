import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CATALOG_GATEWAY_PORT,
  ICatalogGatewayPort,
} from '../types/catalog-gateway.types';
import { ResilienceRegistryService } from '../../shared-kernel/resilience/resilience-registry.service';

/**
 * Remote HTTP Adapter connecting Ingestion/Processing to standalone Catalog Microservice.
 * Handles lifecycle operations: create, update, delete, duplicate queries, and audits.
 */
@Injectable()
export class HttpCatalogGatewayAdapter implements ICatalogGatewayPort {
  private readonly logger = new Logger(HttpCatalogGatewayAdapter.name);

  constructor(
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly resilienceRegistry?: ResilienceRegistryService,
  ) {}

  private getBaseUrl(): string {
    return (
      this.configService?.get<string>('LIBRARY_CATALOG_URL') ||
      process.env.LIBRARY_CATALOG_URL ||
      'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  async getItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<any | null> {
    const baseUrl = this.getBaseUrl();
    const url = projectId
      ? `${baseUrl}/api/v1/projects/${projectId}/library/items/${itemId}`
      : `${baseUrl}/api/v1/library/items/${itemId}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-user-id': userId, 'Content-Type': 'application/json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Catalog getItem failed: ${res.statusText}`);
    const json = await res.json();
    return json?.data ?? json;
  }

  async createItem(
    userId: string,
    data: any,
    options?: any,
    projectId?: string,
  ): Promise<any> {
    const baseUrl = this.getBaseUrl();
    const url = projectId
      ? `${baseUrl}/api/v1/projects/${projectId}/library/items`
      : `${baseUrl}/api/v1/library/items`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-user-id': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, ...options }),
    });
    if (!res.ok)
      throw new Error(`Catalog createItem failed: ${res.statusText}`);
    const json = await res.json();
    return json?.data ?? json;
  }

  async updateItem(
    userId: string,
    itemId: string,
    data: any,
    expectedVersion?: number,
    projectId?: string,
  ): Promise<any> {
    const baseUrl = this.getBaseUrl();
    const url = projectId
      ? `${baseUrl}/api/v1/projects/${projectId}/library/items/${itemId}`
      : `${baseUrl}/api/v1/library/items/${itemId}`;

    const headers: Record<string, string> = {
      'x-user-id': userId,
      'Content-Type': 'application/json',
    };
    if (expectedVersion !== undefined) {
      headers['if-match'] = String(expectedVersion);
    }

    const res = await fetch(url, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(data),
    });
    if (!res.ok)
      throw new Error(`Catalog updateItem failed: ${res.statusText}`);
    const json = await res.json();
    return json?.data ?? json;
  }

  async deleteItem(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<void> {
    const baseUrl = this.getBaseUrl();
    const url = projectId
      ? `${baseUrl}/api/v1/projects/${projectId}/library/items/${itemId}`
      : `${baseUrl}/api/v1/library/items/${itemId}`;

    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'x-user-id': userId },
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Catalog deleteItem failed: ${res.statusText}`);
    }
  }

  async findDuplicateCandidateItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<any[]> {
    const baseUrl = this.getBaseUrl();
    const url = projectId
      ? `${baseUrl}/api/v1/projects/${projectId}/library/items/curation/duplicates?limit=${limit || 50}`
      : `${baseUrl}/api/v1/library/items/curation/duplicates?limit=${limit || 50}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-user-id': userId },
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json?.data ?? json ?? [];
  }

  async findByIds(
    userId: string,
    ids: string[],
    projectId?: string,
  ): Promise<any[]> {
    if (!ids || ids.length === 0) return [];
    const results = await Promise.all(
      ids.map((id) => this.getItem(userId, id, projectId)),
    );
    return results.filter(
      (item): item is NonNullable<typeof item> => item !== null,
    );
  }

  async mergeItems(
    tx: any,
    duplicateItemIds: string[],
    primaryItemId: string,
  ): Promise<void> {
    const baseUrl = this.getBaseUrl();
    const url = `${baseUrl}/api/v1/library/items/curation/merge`;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ primaryItemId, duplicateItemIds }),
    });
    if (!res.ok)
      throw new Error(`Catalog mergeItems failed: ${res.statusText}`);
  }

  async findQualityAuditItems(
    userId: string,
    limit?: number,
    projectId?: string,
  ): Promise<any[]> {
    const baseUrl = this.getBaseUrl();
    const url = projectId
      ? `${baseUrl}/api/v1/projects/${projectId}/library/items/curation/quality-audit?limit=${limit || 50}`
      : `${baseUrl}/api/v1/library/items/curation/quality-audit?limit=${limit || 50}`;

    const res = await fetch(url, {
      method: 'GET',
      headers: { 'x-user-id': userId },
    });
    if (!res.ok) return [];
    const json = await res.json();
    return json?.data ?? json ?? [];
  }

  getOrderedFields(itemType: string): any[] {
    return [];
  }

  getPrimaryCreatorType(itemType: string): string {
    return 'author';
  }

  async createNote(userId: string, data: any): Promise<any> {
    const baseUrl = this.getBaseUrl();
    const url = `${baseUrl}/api/v1/library/notes`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'x-user-id': userId, 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data ?? json;
  }

  async itemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean> {
    const item = await this.getItem(userId, itemId, projectId);
    return item !== null;
  }
}
