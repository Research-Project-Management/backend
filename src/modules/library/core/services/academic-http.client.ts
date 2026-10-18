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

  constructor(
    private readonly ssrfGuard: SsrfGuardService,
    private readonly resilience: ResilienceRegistryService,
    private readonly config: LibraryConfigService,
  ) {}

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
    const requireSsrf = options.requireSsrfCheck ?? false;

    let currentUrl = url;
    let redirectCount = 0;

    while (redirectCount <= maxRedirects) {
      if (requireSsrf) {
        await this.ssrfGuard.assertSafeUrl(currentUrl);
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      // Merge signals if parent signal exists
      const effectiveSignal = options.signal
        ? AbortSignal.any
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal
        : controller.signal;

      try {
        const response = await fetch(currentUrl, {
          method: options.method ?? 'GET',
          headers: {
            ...this.getDefaultHeaders(),
            ...(options.headers || {}),
          },
          body: options.body as BodyInit | null | undefined,
          redirect: 'manual',
          signal: effectiveSignal,
        });

        clearTimeout(timeoutId);

        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) {
            return { response, finalUrl: currentUrl };
          }
          currentUrl = new URL(location, currentUrl).toString();
          redirectCount++;
          continue;
        }

        return { response, finalUrl: currentUrl };
      } catch (err: unknown) {
        clearTimeout(timeoutId);
        const errMsg = err instanceof Error ? err.message : String(err);
        throw new ExternalProviderException(
          `HTTP fetch failed for URL ${currentUrl}: ${errMsg}`,
          { url: currentUrl, cause: errMsg },
        );
      }
    }

    throw new ExternalProviderException(
      `Exceeded max redirects (${maxRedirects}) for URL ${url}`,
      { url, maxRedirects },
    );
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

        try {
          return (await response.json()) as T;
        } catch (err: unknown) {
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

    return this.resilience.execute(
      resilienceKey,
      async () => {
        const { response, finalUrl } = await this.fetchWithRedirects(
          url,
          options,
        );

        const body = await response.text();
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

    return this.resilience.execute(
      resilienceKey,
      async () => {
        const { response, finalUrl } = await this.fetchWithRedirects(
          url,
          options,
        );

        const arrayBuf = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);
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
