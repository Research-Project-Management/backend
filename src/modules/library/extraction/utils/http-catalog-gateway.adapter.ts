import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CATALOG_GATEWAY_PORT,
  ICatalogGatewayPort,
} from '../types/catalog-gateway.types';
import { ResilienceRegistryService } from '../../shared-kernel/resilience/resilience-registry.service';

/**
 * Remote HTTP Adapter connecting Extraction Bounded Context to standalone Catalog Microservice.
 * Protected by CircuitBreaker and configurable request timeouts.
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

  async itemExists(
    userId: string,
    itemId: string,
    projectId?: string,
  ): Promise<boolean> {
    const item = await this.getItem(userId, itemId, projectId);
    return item !== null;
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

        if (response.status === 404) {
          return null;
        }

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
}
