import { createHash } from 'crypto';
import { IngestionCommand } from '../types/ingestion.types';
import { isIP } from 'net';

export const INGESTION_LIMITS = {
  MAX_PDF_SIZE_BYTES: 50 * 1024 * 1024, // 50MB
  MAX_BIBTEX_SIZE_BYTES: 10 * 1024 * 1024, // 10MB
  ALLOWED_PDF_MIME_TYPES: [
    'application/pdf',
    'application/x-pdf',
    'application/octet-stream',
  ],
  DEFAULT_IDEMPOTENCY_TTL_SECONDS: 86400, // 24 hours
} as const;

/**
 * Normalizes DOI strings into canonical format (lower-case, prefix stripped).
 */
export function normalizeDoi(rawDoi?: string | null): string {
  if (!rawDoi) return '';
  let cleaned = rawDoi.trim();
  cleaned = cleaned.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  cleaned = cleaned.replace(/^doi:\s*/i, '');
  cleaned = cleaned.replace(/[.,;)\]]+$/, '');
  return cleaned.toLowerCase().trim();
}

/**
 * Canonicalizes a URL (normalizes protocol/host casing, removes default ports, fragments, and tracking params).
 */
export function normalizeCanonicalUrl(rawUrl?: string | null): string {
  if (!rawUrl) return '';
  try {
    const parsed = new URL(rawUrl.trim());
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = '';

    // Remove default ports
    if (
      (parsed.protocol === 'http:' && parsed.port === '80') ||
      (parsed.protocol === 'https:' && parsed.port === '443')
    ) {
      parsed.port = '';
    }

    // Strip common tracking parameters safely
    const trackingParams = [
      'utm_source',
      'utm_medium',
      'utm_campaign',
      'utm_term',
      'utm_content',
      'fbclid',
      'gclid',
      'ref',
      'ref_src',
    ];
    for (const param of trackingParams) {
      parsed.searchParams.delete(param);
    }

    return parsed.toString();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

/**
 * Validates a PDF buffer for magic bytes, size limits, and returns real SHA-256 checksum.
 */
export function validatePdfBuffer(buffer: Buffer): {
  fileHash: string;
  sizeBytes: number;
} {
  if (buffer.length > INGESTION_LIMITS.MAX_PDF_SIZE_BYTES) {
    throw new Error(
      `PDF size exceeds maximum allowable limit of ${INGESTION_LIMITS.MAX_PDF_SIZE_BYTES / (1024 * 1024)}MB`,
    );
  }

  if (buffer.length < 4 || buffer.subarray(0, 4).toString('utf-8') !== '%PDF') {
    throw new Error('Invalid PDF content: Missing %PDF magic bytes header');
  }

  const fileHash = createHash('sha256').update(buffer).digest('hex');
  return { fileHash, sizeBytes: buffer.length };
}

/**
 * Calculates a deterministic, collision-resistant hash of the ingestion command for idempotency.
 */
export function calculateIngestionRequestHash(
  command: IngestionCommand,
): string {
  const normalized: Record<string, any> = {
    source: command.source,
    workspaceId: command.workspaceId,
  };

  switch (command.source) {
    case 'doi':
      normalized.doi = normalizeDoi(command.doi);
      normalized.collectionId = command.collectionId;
      break;

    case 'url':
      normalized.url = normalizeCanonicalUrl(command.url);
      normalized.previewToken = command.previewToken;
      normalized.collectionId = command.collectionId;
      if (command.overrides) {
        normalized.overrides = command.overrides;
      }
      break;

    case 'bibtex':
      normalized.content = (command.content || '').trim();
      normalized.collectionId = command.collectionId;
      break;

    case 'pdf':
      normalized.fileId = command.fileId;
      normalized.filename = command.filename;
      normalized.collectionId = command.collectionId;
      if (command.overrides) {
        normalized.overrides = command.overrides;
      }
      break;
  }

  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/**
 * Validates SSRF target URLs (disallow private IP ranges, loopbacks, non-http protocols).
 */
export function validateUrlSecurity(urlString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error('Invalid URL format');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Forbidden protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local')
  ) {
    throw new Error(`SSRF violation: Forbidden target domain ${hostname}`);
  }

  const cleanIp = hostname.replace(/^\[|\]$/g, '');
  if (isIP(cleanIp)) {
    if (
      cleanIp === '127.0.0.1' ||
      cleanIp === '::1' ||
      cleanIp.startsWith('127.') ||
      cleanIp.startsWith('10.') ||
      cleanIp.startsWith('192.168.') ||
      cleanIp.startsWith('169.254.') ||
      cleanIp.startsWith('fc00:') ||
      cleanIp.startsWith('fe80:') ||
      cleanIp === '0.0.0.0' ||
      cleanIp === '::' ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(cleanIp)
    ) {
      throw new Error(`SSRF violation: Forbidden IP ${cleanIp}`);
    }
  }
}
