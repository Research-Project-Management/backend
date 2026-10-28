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

export const METADATA_POLICY_VERSION = 2;

export interface RoutingTiers {
  authoritative: ProviderName[];
  enrichment: ProviderName[];
  fallback: ProviderName[];
}

export class MetadataRoutingPolicy {
  static readonly PARALLEL_LIMIT = 3;
  private static readonly ssrfGuard = new SsrfGuardService();

  static getTiers(queryType: QueryType): RoutingTiers {
    switch (queryType) {
      case 'DOI':
        return {
          authoritative: ['CrossRef'],
          enrichment: ['Unpaywall', 'OpenAlex', 'SemanticScholar'],
          fallback: ['OpenAlex', 'SemanticScholar', 'DBLP'],
        };

      case 'ARXIV':
        return {
          authoritative: ['arXiv'],
          enrichment: ['OpenAlex', 'SemanticScholar'],
          fallback: ['CrossRef', 'OpenAlex', 'SemanticScholar'],
        };

      case 'PMID':
        return {
          authoritative: ['PubMed'],
          enrichment: ['OpenAlex', 'SemanticScholar'],
          fallback: ['OpenAlex', 'SemanticScholar'],
        };

      case 'ISBN':
        return {
          authoritative: ['OpenLibrary'],
          enrichment: ['OpenAlex'],
          fallback: ['OpenAlex'],
        };

      case 'URL':
        return {
          authoritative: ['OpenAlex'],
          enrichment: [],
          fallback: ['CrossRef'],
        };

      case 'TITLE':
      default:
        return {
          authoritative: ['CrossRef'],
          enrichment: ['OpenAlex', 'SemanticScholar', 'DBLP'],
          fallback: ['OpenAlex', 'DBLP', 'SemanticScholar'],
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

