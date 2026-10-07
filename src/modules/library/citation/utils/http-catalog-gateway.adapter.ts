import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CATALOG_GATEWAY_PORT,
  ICatalogGatewayPort,
} from '../types/citation.types';
import { ResilienceRegistryService } from '../../shared-kernel/resilience/resilience-registry.service';

/**
 * Remote HTTP Adapter connecting Citation Bounded Context to standalone Catalog Microservice.
 * Handles fetching individual items or batch items by IDs for citation formatting and bibliography export.
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
    const breaker = this.resilienceRegistry?.getCircuitBreaker(
      'catalog-microservice',
      {
        failureThreshold: 5,
        resetTimeoutMs: 15000,
      },
    );

    const executeRequest = async (): Promise<any | null> => {
      const url = projectId
        ? `${baseUrl}/api/v1/projects/${projectId}/library/items/${itemId}`
        : `${baseUrl}/api/v1/library/items/${itemId}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: {
            'x-user-id': userId,
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });

        if (response.status === 404) return null;
        if (!response.ok) {
          throw new Error(
            `Catalog service returned ${response.status}: ${response.statusText}`,
          );
        }

        const json = await response.json();
        return json?.data ?? json;
      } catch (err: any) {
        if (err?.name === 'AbortError') {
          this.logger.warn(`Catalog HTTP request timed out for item ${itemId}`);
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    };

    if (breaker) {
      return breaker.execute(executeRequest, async (err: any) => {
        this.logger.warn(
          `Catalog service circuit open or unavailable: ${err?.message || err}`,
        );
        return null;
      });
    }

    return executeRequest();
  }

  async findByIds(
    userId: string,
    itemIds: string[],
    projectId?: string,
  ): Promise<any[]> {
    if (!itemIds || itemIds.length === 0) return [];

    const baseUrl = this.getBaseUrl();
    const breaker = this.resilienceRegistry?.getCircuitBreaker(
      'catalog-microservice',
      {
        failureThreshold: 5,
        resetTimeoutMs: 15000,
      },
    );

    const executeRequest = async (): Promise<any[]> => {
      const url = projectId
        ? `${baseUrl}/api/v1/projects/${projectId}/library/items/batch`
        : `${baseUrl}/api/v1/library/items/batch`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'x-user-id': userId,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ids: itemIds }),
          signal: controller.signal,
        });

        if (response.ok) {
          const json = await response.json();
          return json?.data ?? json ?? [];
        }

        // Fallback: concurrently fetch individual items if batch endpoint is unavailable
        const results = await Promise.all(
          itemIds.map((id) => this.getItem(userId, id, projectId)),
        );
        return results.filter(
          (item): item is NonNullable<typeof item> => item !== null,
        );
      } catch (err: any) {
        this.logger.warn(
          `Batch fetch failed, attempting parallel individual fetch: ${err.message}`,
        );
        const results = await Promise.all(
          itemIds.map((id) => this.getItem(userId, id, projectId)),
        );
        return results.filter(
          (item): item is NonNullable<typeof item> => item !== null,
        );
      } finally {
        clearTimeout(timeoutId);
      }
    };

    if (breaker) {
      return breaker.execute(executeRequest, async (err: any) => {
        this.logger.warn(
          `Catalog service unavailable for findByIds: ${err?.message || err}`,
        );
        return [];
      });
    }

    return executeRequest();
  }
}
