import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'node:crypto';
import { CircuitBreaker, getErrorMessage, tryCatch } from '@/core';
import { resolveServiceUrl } from '@/core/utils/public-urls';

@Injectable()
export class EngineHttpService {
  private readonly fluxUrl: string;
  private readonly internalApiKey: string;
  private readonly logger = new Logger(EngineHttpService.name);
  private readonly circuitBreaker = new CircuitBreaker({
    name: 'FluxAIEngine',
    failureThreshold: 3,
    cooldownMs: 20000,
  });

  constructor(private readonly configService: ConfigService) {
    this.fluxUrl = resolveServiceUrl(
      'FLUX_AI_URL',
      this.configService.get<string>('FLUX_AI_URL'),
      'http://127.0.0.1:18420',
    ).replace(/\/+$/, '');
    this.internalApiKey = (
      this.configService.get<string>('AI_INTERNAL_API_KEY') ??
      this.configService.get<string>('INTERNAL_API_KEY') ??
      ''
    ).trim();
  }

  getBaseUrl(): string {
    return this.fluxUrl;
  }

  getInternalHeaders(
    traceId?: string,
    delegationToken?: string,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'X-Trace-Id': traceId?.trim() || crypto.randomUUID(),
    };
    if (this.internalApiKey) {
      headers['X-Internal-Key'] = this.internalApiKey;
    }
    const cleanToken = delegationToken?.trim();
    if (cleanToken) {
      headers.Authorization = cleanToken.toLowerCase().startsWith('bearer ')
        ? cleanToken
        : `Bearer ${cleanToken}`;
    }
    return headers;
  }

  async requestJson<T>(
    path: string,
    options: {
      method?: 'GET' | 'POST' | 'DELETE';
      body?: unknown;
      timeoutMs?: number;
      traceId?: string;
      delegationToken?: string;
      skipCircuitBreaker?: boolean;
    } = {},
  ): Promise<T> {
    const method = options.method ?? 'GET';
    const timeoutMs = options.timeoutMs ?? 60000;

    if (!options.skipCircuitBreaker && this.circuitBreaker.isOpen()) {
      throw new ServiceUnavailableException(
        'AI service is temporarily unavailable (circuit breaker is open)',
      );
    }

    const headers: Record<string, string> = {
      ...this.getInternalHeaders(options.traceId, options.delegationToken),
    };
    let requestBody: BodyInit | undefined;

    if (options.body instanceof FormData) {
      requestBody = options.body;
    } else if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      requestBody = JSON.stringify(options.body);
    }

    const res = await tryCatch(
      fetch(`${this.fluxUrl}${path}`, {
        method,
        headers,
        body: requestBody,
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );

    if (!res.ok) {
      const message = getErrorMessage(res.error);
      if (!options.skipCircuitBreaker) {
        this.circuitBreaker.recordFailure(message);
      }
      this.logger.warn(`AI request failed [${method} ${path}]: ${message}`);
      throw new ServiceUnavailableException(
        `AI service unreachable: ${message}`,
      );
    }

    const response = res.value;
    if (!response.ok) {
      const detail = await this.extractErrorDetail(response);
      if (response.status >= 500) {
        if (!options.skipCircuitBreaker) {
          this.circuitBreaker.recordFailure(detail);
        }
        throw new ServiceUnavailableException(
          `AI service upstream error (${response.status}): ${detail}`,
        );
      }
      throw this.mapClientError(response.status, detail);
    }

    if (!options.skipCircuitBreaker) {
      this.circuitBreaker.recordSuccess();
    }

    const jsonRes = await tryCatch(response.json());
    if (!jsonRes.ok) {
      throw new ServiceUnavailableException('Invalid JSON response from AI');
    }
    return jsonRes.value as T;
  }

  async openStream(
    path: string,
    body: unknown,
    signal: AbortSignal,
    traceId?: string,
    delegationToken?: string,
  ): Promise<Response> {
    if (this.circuitBreaker.isOpen()) {
      throw new ServiceUnavailableException(
        'AI service is temporarily unavailable (circuit breaker is open)',
      );
    }

    const res = await tryCatch(
      fetch(`${this.fluxUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          ...this.getInternalHeaders(traceId, delegationToken),
        },
        body: JSON.stringify(body),
        signal,
      }),
    );

    if (!res.ok) {
      const message = getErrorMessage(res.error);
      if (!signal.aborted) {
        this.circuitBreaker.recordFailure(message);
      }
      throw new ServiceUnavailableException(`AI stream failed: ${message}`);
    }

    const response = res.value;
    if (!response.ok) {
      const detail = await this.extractErrorDetail(response);
      if (response.status >= 500) {
        this.circuitBreaker.recordFailure(detail);
        throw new ServiceUnavailableException(
          `AI stream upstream error (${response.status}): ${detail}`,
        );
      }
      throw this.mapClientError(response.status, detail);
    }

    this.circuitBreaker.recordSuccess();
    return response;
  }

  private async extractErrorDetail(response: Response): Promise<string> {
    const raw = await response.text().catch(() => '');
    if (!raw) return `HTTP ${response.status}`;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && 'detail' in parsed) {
        const detail = parsed.detail;
        return typeof detail === 'string' ? detail : JSON.stringify(detail);
      }
    } catch {
      // Plain text error body
    }
    return raw.slice(0, 400);
  }

  private mapClientError(status: number, detail: string): HttpException {
    switch (status) {
      case 400:
        return new BadRequestException(detail);
      case 401:
        return new UnauthorizedException(detail);
      case 403:
        return new ForbiddenException(detail);
      case 404:
        return new NotFoundException(detail);
      case 422:
        return new UnprocessableEntityException(detail);
      case 429:
        return new HttpException(detail, HttpStatus.TOO_MANY_REQUESTS);
      default:
        return new HttpException(detail, status);
    }
  }
}
