import { Injectable, Logger } from '@nestjs/common';
import { ResilienceRegistryService } from '@/modules/library/core/resilience/resilience-registry.service';
import { LibraryConfigService, libraryConfig } from '@/modules/library/core/config/library.config';
import { ExternalProviderException } from '@/modules/library/core/errors/domain.exception';
import {
  readSafeResponseBuffer,
  readSafeResponseText,
  MAX_SAFE_HTTP_PAYLOAD_BYTES,
} from '@/modules/library/core/domain/title.domain';
import { SsrfGuardService } from './ssrf-guard.service';

/**
 * Canonical Academic Polite Pool Email and User-Agent configuration.
 * Used for CrossRef, OpenAlex, PubMed, Unpaywall, DOI content negotiation,
 * Retraction Watch, and academic crawler polite pools.
 */
export function getContactEmail(): string {
  return libraryConfig().academic.contactEmail;
}

export function getUserAgent(subsystem = 'Platform'): string {
  const email = getContactEmail();
  return `FluxResearch${subsystem}/1.0 (mailto:${email}; https://flux.study)`;
}

export interface HttpRequestOptions {
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

function wrapResponseWithBodyTimeout(
  res: Response,
  timeoutId: NodeJS.Timeout,
  maxBytes?: number,
): Response {
  const clear = () => clearTimeout(timeoutId);
  if (!res || typeof res !== 'object') {
    clear();
    return res;
  }

  // If the HTTP status is non-OK (e.g. 404, 429, 500) or 204/304 (no body),
  // callers frequently inspect `res.status` and return/throw without consuming `.text()` / `.json()`.
  // Clear the body timeout immediately so `timeoutId` never leaks on the Node.js timer heap.
  if (!res.ok || res.status === 204 || res.status === 304) {
    clear();
  }

  let wrappedBody: ReadableStream<Uint8Array> | null | undefined;
  let bodyAccessed = false;

  return new Proxy(res, {
    get(target, prop, receiver) {
      if (prop === 'text') {
        return async () => {
          try {
            if (maxBytes !== undefined) {
              return await readSafeResponseText(target, maxBytes);
            }
            return await target.text();
          } finally {
            clear();
          }
        };
      }
      if (prop === 'json') {
        return async () => {
          try {
            if (maxBytes !== undefined) {
              const text = await readSafeResponseText(target, maxBytes);
              return JSON.parse(text);
            }
            return await target.json();
          } finally {
            clear();
          }
        };
      }
      if (prop === 'arrayBuffer') {
        return async () => {
          try {
            if (maxBytes !== undefined) {
              const buf = await readSafeResponseBuffer(target, maxBytes);
              return buf.buffer.slice(
                buf.byteOffset,
                buf.byteOffset + buf.byteLength,
              );
            }
            return await target.arrayBuffer();
          } finally {
            clear();
          }
        };
      }
      if (prop === 'body') {
        if (!bodyAccessed) {
          bodyAccessed = true;
          const origBody = target.body as ReadableStream<Uint8Array> | null;
          if (!origBody || typeof origBody.getReader !== 'function') {
            clear();
            wrappedBody = origBody;
          } else {
            const reader = origBody.getReader();
            let totalBytes = 0;
            wrappedBody = new ReadableStream<Uint8Array>({
              async pull(controller) {
                try {
                  const { done, value } = await reader.read();
                  if (done) {
                    clear();
                    controller.close();
                    return;
                  }
                  if (value) {
                    totalBytes += value.byteLength;
                    if (maxBytes !== undefined && totalBytes > maxBytes) {
                      clear();
                      await reader.cancel();
                      controller.error(
                        new Error(
                          `Response stream exceeded maxBytes limit (${maxBytes} bytes)`,
                        ),
                      );
                      return;
                    }
                    controller.enqueue(value);
                  }
                } catch (err) {
                  clear();
                  controller.error(err);
                }
              },
              async cancel(reason) {
                clear();
                await reader.cancel(reason);
              },
            });
          }
        }
        return wrappedBody;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

@Injectable()
export class HttpClient {
  private readonly logger = new Logger(HttpClient.name);

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
    options: HttpRequestOptions = {},
    externalSignal?: AbortSignal,
  ): Promise<{ response: Response; finalUrl: string }> {
    const timeoutMs = options.timeoutMs ?? this.config.http.defaultTimeoutMs;
    const maxRedirects = options.maxRedirects ?? this.config.http.maxRedirects;
    const requireSsrf = options.requireSsrfCheck ?? true;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const signals = [
      controller.signal,
      ...(options.signal ? [options.signal] : []),
      ...(externalSignal ? [externalSignal] : []),
    ];
    const effectiveSignal =
      signals.length > 1 && AbortSignal.any
        ? AbortSignal.any(signals)
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
      const resObj = requireSsrf
        ? await this.ssrfGuard.safeFetchWithRedirects(url, init, {
            maxRedirects,
          })
        : await SsrfGuardService.executeSafeRedirectFetch(url, init, {
            maxRedirects,
          });
      return {
        ...resObj,
        response: wrapResponseWithBodyTimeout(
          resObj.response,
          timeoutId,
          options.maxBytes,
        ),
      };
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      const errMsg = err instanceof Error ? err.message : String(err);
      throw new ExternalProviderException(
        `HTTP fetch failed for URL ${url}: ${errMsg}`,
        { url, cause: errMsg },
      );
    }
  }

  async request(
    url: string,
    options: HttpRequestOptions = {},
  ): Promise<{ response: Response; finalUrl: string }> {
    const resilienceKey = options.resilienceKey ?? new URL(url).hostname;
    return this.resilience.execute(
      resilienceKey,
      async () => {
        const result = await this.fetchWithRedirects(url, options);
        if (result.response.status >= 500 || result.response.status === 429) {
          const breaker = this.resilience.getCircuitBreaker(resilienceKey);
          breaker.recordFailure(true);
        }
        return result;
      },
      { signal: options.signal },
    );
  }

  async requestText(
    url: string,
    options: HttpRequestOptions = {},
  ): Promise<{ text: string; response: Response; finalUrl: string }> {
    const { response, finalUrl } = await this.request(url, options);
    const text = await readSafeResponseText(
      response,
      options.maxBytes ?? 5 * 1024 * 1024,
    );
    return { text, response, finalUrl };
  }

  async requestBuffer(
    url: string,
    options: HttpRequestOptions = {},
  ): Promise<{ buffer: Buffer; response: Response; finalUrl: string }> {
    const { response, finalUrl } = await this.request(url, options);
    const buffer = await readSafeResponseBuffer(
      response,
      options.maxBytes ?? MAX_SAFE_HTTP_PAYLOAD_BYTES,
    );
    return { buffer, response, finalUrl };
  }
}
