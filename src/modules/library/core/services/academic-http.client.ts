import { Injectable, Logger } from '@nestjs/common';
import { SsrfGuardService } from './ssrf-guard.service';
import { ResilienceRegistryService } from '../resilience/resilience-registry.service';
import { LibraryConfigService } from '../config/library.config';
import { ExternalProviderException } from '../errors/domain.exception';

export interface AcademicHttpRequestOptions {
  method?: 'GET' | 'POST' | 'HEAD';
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRedirects?: number;
  maxBytes?: number;
  resilienceKey?: string;
  requireSsrfCheck?: boolean;
  body?: string | Buffer | URLSearchParams;
  signal?: AbortSignal;
}

export interface HttpResponseText {
  status: number;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
}

export interface HttpResponseBuffer {
  status: number;
  headers: Record<string, string>;
  buffer: Buffer;
  finalUrl: string;
}

@Injectable()
export class AcademicHttpClient {
  private readonly logger = new Logger(AcademicHttpClient.name);
  private static readonly MAX_TEXT_BYTES = 10 * 1024 * 1024; // 10 MB
  private static readonly MAX_BUFFER_BYTES = 50 * 1024 * 1024; // 50 MB

  constructor(
    private readonly ssrfGuard: SsrfGuardService,
    private readonly resilience: ResilienceRegistryService,
    private readonly config: LibraryConfigService,
  ) {}

  private assertContentLengthWithinLimit(
    response: Response,
    finalUrl: string,
    maxBytes: number,
  ): void {
    const contentLengthHeader =
      typeof response.headers?.get === 'function'
        ? response.headers.get('content-length')
        : null;
    if (contentLengthHeader) {
      const contentLength = Number.parseInt(contentLengthHeader, 10);
      if (!Number.isNaN(contentLength) && contentLength > maxBytes) {
        throw new ExternalProviderException(
          `Response from ${finalUrl} exceeds maximum allowed size (${contentLength} > ${maxBytes} bytes)`,
          { url: finalUrl, contentLength, maxBytes },
        );
      }
    }
  }

  private assertByteLengthWithinLimit(
    byteLength: number,
    finalUrl: string,
    maxBytes: number,
  ): void {
    if (byteLength > maxBytes) {
      throw new ExternalProviderException(
        `Response body from ${finalUrl} exceeds maximum allowed size (${byteLength} > ${maxBytes} bytes)`,
        { url: finalUrl, byteLength, maxBytes },
      );
    }
  }

  private getDefaultHeaders(): Record<string, string> {
    return {
      'User-Agent': this.config.academic.userAgent,
      Accept: 'application/json, text/plain, */*',
    };
  }

  private async fetchWithRedirects(
    url: string,
    options: AcademicHttpRequestOptions = {},
  ): Promise<{ response: Response; finalUrl: string }> {
    const timeoutMs = options.timeoutMs ?? this.config.http.defaultTimeoutMs;
    const maxRedirects = options.maxRedirects ?? this.config.http.maxRedirects;
    const requireSsrf = options.requireSsrfCheck ?? true;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const effectiveSignal = options.signal
      ? AbortSignal.any
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal
      : controller.signal;

    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers: {
        ...this.getDefaultHeaders(),
        ...(options.headers || {}),
      },
      body: options.body as BodyInit | null | undefined,
      signal: effectiveSignal,
    };

    try {
      if (requireSsrf) {
        return await this.ssrfGuard.safeFetchWithRedirects(url, init, {
          maxRedirects,
        });
      }
      return await SsrfGuardService.executeSafeRedirectFetch(url, init, {
        maxRedirects,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new ExternalProviderException(
        `HTTP fetch failed for URL ${url}: ${errMsg}`,
        { url, cause: errMsg },
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async request(
    url: string,
    options: AcademicHttpRequestOptions = {},
  ): Promise<{ response: Response; finalUrl: string }> {
    const resilienceKey = options.resilienceKey ?? new URL(url).hostname;
    return this.resilience.execute(
      resilienceKey,
      () => this.fetchWithRedirects(url, options),
      { signal: options.signal },
    );
  }

  async requestJson<T>(
    url: string,
    options: AcademicHttpRequestOptions = {},
  ): Promise<T> {
    const resilienceKey = options.resilienceKey ?? new URL(url).hostname;
    const maxBytes = options.maxBytes ?? AcademicHttpClient.MAX_TEXT_BYTES;

    return this.resilience.execute(
      resilienceKey,
      async () => {
        const { response, finalUrl } = await this.fetchWithRedirects(
          url,
          options,
        );

        if (!response.ok) {
          throw new ExternalProviderException(
            `HTTP request failed with status ${response.status} from ${finalUrl}`,
            { url: finalUrl, status: response.status },
          );
        }

        this.assertContentLengthWithinLimit(response, finalUrl, maxBytes);

        try {
          if (typeof response.text === 'function') {
            const rawText = await response.text();
            this.assertByteLengthWithinLimit(
              Buffer.byteLength(rawText, 'utf8'),
              finalUrl,
              maxBytes,
            );
            return JSON.parse(rawText) as T;
          }
          return (await response.json()) as T;
        } catch (err: unknown) {
          if (err instanceof ExternalProviderException) {
            throw err;
          }
          const errMsg = err instanceof Error ? err.message : String(err);
          throw new ExternalProviderException(
            `Failed to parse JSON response from ${finalUrl}: ${errMsg}`,
            { url: finalUrl, cause: errMsg },
          );
        }
      },
      { signal: options.signal },
    );
  }

  async requestText(
    url: string,
    options: AcademicHttpRequestOptions = {},
  ): Promise<HttpResponseText> {
    const resilienceKey = options.resilienceKey ?? new URL(url).hostname;
    const maxBytes = options.maxBytes ?? AcademicHttpClient.MAX_TEXT_BYTES;

    return this.resilience.execute(
      resilienceKey,
      async () => {
        const { response, finalUrl } = await this.fetchWithRedirects(
          url,
          options,
        );

        this.assertContentLengthWithinLimit(response, finalUrl, maxBytes);
        const body = await response.text();
        this.assertByteLengthWithinLimit(
          Buffer.byteLength(body, 'utf8'),
          finalUrl,
          maxBytes,
        );
        const headers: Record<string, string> = {};
        response.headers.forEach((val, key) => {
          headers[key] = val;
        });

        return {
          status: response.status,
          headers,
          body,
          finalUrl,
        };
      },
      { signal: options.signal },
    );
  }

  async requestBuffer(
    url: string,
    options: AcademicHttpRequestOptions = {},
  ): Promise<HttpResponseBuffer> {
    const resilienceKey = options.resilienceKey ?? new URL(url).hostname;
    const maxBytes = options.maxBytes ?? AcademicHttpClient.MAX_BUFFER_BYTES;

    return this.resilience.execute(
      resilienceKey,
      async () => {
        const { response, finalUrl } = await this.fetchWithRedirects(
          url,
          options,
        );

        this.assertContentLengthWithinLimit(response, finalUrl, maxBytes);
        const arrayBuf = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
        this.assertByteLengthWithinLimit(buffer.byteLength, finalUrl, maxBytes);
        const headers: Record<string, string> = {};
        response.headers.forEach((val, key) => {
          headers[key] = val;
        });

        return {
          status: response.status,
          headers,
          buffer,
          finalUrl,
        };
      },
      { signal: options.signal },
    );
  }
}
