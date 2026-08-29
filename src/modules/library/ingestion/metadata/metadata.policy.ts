import { ConflictException } from '@nestjs/common';
import { ProviderName, QueryType } from './metadata.contracts';

export const METADATA_POLICY_VERSION = 1;

export interface RoutingTiers {
  authoritative: ProviderName[];
  enrichment: ProviderName[];
  fallback: ProviderName[];
}

const SSRF_BLOCKED_PATTERNS = [
  /^localhost$/i,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^0\.0\.0\.0$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  /^100\.100\.100\.200$/, // Alibaba Cloud metadata
  /^metadata\.google\.internal$/i,
  /^::1$/, // IPv6 loopback
  /^fe80:/i, // IPv6 link-local
  /^fc00:/i, // IPv6 unique local
  /^fd00:/i, // IPv6 unique local
];

export class MetadataRoutingPolicy {
  static readonly PARALLEL_LIMIT = 3;

  static getTiers(queryType: QueryType): RoutingTiers {
    switch (queryType) {
      case 'DOI':
        return {
          authoritative: ['CrossRef'],
          enrichment: ['SemanticScholar', 'Unpaywall', 'OpenAlex'],
          fallback: ['OpenAlex'],
        };

      case 'ARXIV':
        return {
          authoritative: ['arXiv'],
          enrichment: ['SemanticScholar', 'OpenAlex'],
          fallback: ['CrossRef'],
        };

      case 'PMID':
        return {
          authoritative: ['PubMed'],
          enrichment: ['SemanticScholar', 'OpenAlex'],
          fallback: [],
        };

      case 'ISBN':
        return {
          authoritative: ['OpenLibrary'],
          enrichment: ['OpenAlex'],
          fallback: ['SemanticScholar'],
        };

      case 'URL':
        return {
          authoritative: ['SemanticScholar'],
          enrichment: [],
          fallback: ['OpenAlex'],
        };

      case 'TITLE':
      default:
        return {
          authoritative: ['SemanticScholar'],
          enrichment: [],
          fallback: ['CrossRef', 'OpenAlex'],
        };
    }
  }

  static validateUrl(rawUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ConflictException(
        `SSRF Protection: Blocked unsupported protocol "${parsed.protocol}" in URL: ${rawUrl}`,
      );
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

    for (const pattern of SSRF_BLOCKED_PATTERNS) {
      if (pattern.test(hostname)) {
        throw new ConflictException(
          `SSRF Protection: Blocked request to restricted host "${hostname}"`,
        );
      }
    }
  }
}
