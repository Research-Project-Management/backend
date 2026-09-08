import { ConflictException } from '@nestjs/common';
import { ProviderName, QueryType } from '../types/metadata.types';

export const METADATA_POLICY_VERSION = 2;

export interface RoutingTiers {
  authoritative: ProviderName[];
  enrichment: ProviderName[];
  fallback: ProviderName[];
}

const SSRF_BLOCKED_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.cluster\.local$/i,
  /^metadata\.google\.internal$/i,
  /^0\.0\.0\.0$/,
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^169\.254\.\d{1,3}\.\d{1,3}$/,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/, // CGNAT RFC 6598
  /^100\.100\.100\.200$/, // Alibaba Cloud metadata
  /^169\.254\.169\.254$/, // Cloud metadata (AWS, GCP, Azure)
  /^22[4-9]\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // Multicast
  /^23\d\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^24\d\.\d{1,3}\.\d{1,3}\.\d{1,3}$/, // Reserved
  /^25[0-5]\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^::1$/, // IPv6 loopback
  /^::$/,
  /^fe[89ab]/i, // IPv6 link-local
  /^fc[0-9a-f]/i, // IPv6 unique local
  /^fd[0-9a-f]/i, // IPv6 unique local
  /^ff[0-9a-f]/i, // IPv6 multicast
];

export class MetadataRoutingPolicy {
  static readonly PARALLEL_LIMIT = 3;

  static getTiers(queryType: QueryType): RoutingTiers {
    switch (queryType) {
      case 'DOI':
        return {
          authoritative: ['CrossRef'],
          enrichment: ['Unpaywall', 'OpenAlex'],
          fallback: ['OpenAlex'],
        };

      case 'ARXIV':
        return {
          authoritative: ['arXiv'],
          enrichment: ['OpenAlex'],
          fallback: ['CrossRef', 'OpenAlex'],
        };

      case 'PMID':
        return {
          authoritative: ['PubMed'],
          enrichment: ['OpenAlex'],
          fallback: ['OpenAlex'],
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
          enrichment: ['OpenAlex'],
          fallback: ['OpenAlex'],
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
