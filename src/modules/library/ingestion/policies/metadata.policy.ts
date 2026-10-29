import { isIP } from 'node:net';
import { BaseDomainException } from '@/modules/library/core/errors/domain.exception';
import {
  ProviderName,
  QueryType,
} from '@/modules/library/ingestion/types/metadata.types';
import { SsrfGuardService } from '@/modules/library/core/services/ssrf-guard.service';

export class SsrfBlockedDomainException extends BaseDomainException {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedDomainException';
  }
}

export const METADATA_POLICY_VERSION = 3;

export interface RoutingOptions {
  includeCitations?: boolean;
  includeReferences?: boolean;
  aggressive?: boolean;
}

export interface RoutingTiers {
  authoritative: ProviderName[];
  enrichment: ProviderName[];
  fallback: ProviderName[];
}

export class MetadataRoutingPolicy {
  static readonly PARALLEL_LIMIT = 2;
  private static readonly ssrfGuard = new SsrfGuardService();

  /**
   * Zotero-inspired metadata routing policy:
   * 1. Single authoritative registry per identifier type (CrossRef, arXiv, PubMed, OpenLibrary).
   * 2. NO parallel enrichment calls during standard ingestion to prevent 429 rate limits (e.g. Semantic Scholar)
   *    and latency bloat.
   * 3. Enrichment (OpenAlex, SemanticScholar) only executes on-demand when graph exploration or citations
   *    are explicitly requested.
   * 4. Fallback is evaluated sequentially only when authoritative resolution returns nothing or fails.
   */
  static getTiers(queryType: QueryType, options?: RoutingOptions): RoutingTiers {
    const wantsGraph = Boolean(
      options?.includeCitations ||
      options?.includeReferences ||
      options?.aggressive,
    );

    switch (queryType) {
      case 'DOI':
        return {
          authoritative: ['CrossRef'],
          enrichment: wantsGraph ? ['OpenAlex', 'SemanticScholar'] : [],
          fallback: ['OpenAlex', 'DBLP'],
        };

      case 'ARXIV':
        return {
          authoritative: ['arXiv'],
          enrichment: wantsGraph ? ['OpenAlex', 'SemanticScholar'] : [],
          fallback: ['CrossRef', 'OpenAlex'],
        };

      case 'PMID':
        return {
          authoritative: ['PubMed'],
          enrichment: wantsGraph ? ['OpenAlex', 'SemanticScholar'] : [],
          fallback: ['OpenAlex'],
        };

      case 'ISBN':
        return {
          authoritative: ['OpenLibrary'],
          enrichment: [],
          fallback: ['OpenAlex'],
        };

      case 'URL':
        return {
          authoritative: ['CrossRef'],
          enrichment: [],
          fallback: ['OpenAlex'],
        };

      case 'TITLE':
      default:
        return {
          authoritative: ['CrossRef'],
          enrichment: wantsGraph ? ['OpenAlex', 'SemanticScholar'] : [],
          fallback: ['OpenAlex', 'DBLP'],
        };
    }
  }

  /**
   * Primary asynchronous URL safety verification delegating to the comprehensive
   * DNS-resolving SsrfGuardService when available, falling back to synchronous validation.
   */
  static async assertSafeUrl(
    rawUrl: string,
    ssrfGuard?: SsrfGuardService,
  ): Promise<void> {
    const guard = ssrfGuard ?? this.ssrfGuard;
    try {
      await guard.assertSafeUrl(rawUrl);
    } catch (err: unknown) {
      throw new SsrfBlockedDomainException(
        err instanceof Error
          ? err.message
          : 'SSRF Protection: Destination blocked by security policy',
      );
    }
  }

  static validateUrl(rawUrl: string, ssrfGuard?: SsrfGuardService): void {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new SsrfBlockedDomainException(
        `SSRF Protection: Malformed or invalid URL "${rawUrl}"`,
      );
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SsrfBlockedDomainException(
        `SSRF Protection: Blocked unsupported protocol "${parsed.protocol}" in URL: ${rawUrl}`,
      );
    }

    if (parsed.username || parsed.password) {
      throw new SsrfBlockedDomainException(
        'SSRF Protection: URLs containing credentials are not permitted.',
      );
    }

    const hostname = parsed.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.+$/, '');
    if (
      !hostname ||
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.cluster.local') ||
      hostname === 'metadata.google.internal'
    ) {
      throw new SsrfBlockedDomainException(
        `SSRF Protection: Blocked request to restricted host "${hostname}"`,
      );
    }

    if (/^(0x[0-9a-f]+|\d+)$/i.test(hostname)) {
      throw new SsrfBlockedDomainException(
        `SSRF Protection: Blocked numeric/hexadecimal IP notation "${hostname}"`,
      );
    }

    const guard = ssrfGuard ?? this.ssrfGuard;
    if (isIP(hostname) && guard.isPrivateOrReservedIp(hostname)) {
      throw new SsrfBlockedDomainException(
        `SSRF Protection: Blocked request to restricted IP "${hostname}"`,
      );
    }
  }
}

