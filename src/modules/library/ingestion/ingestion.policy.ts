import { createHash } from 'crypto';
import { IngestionCommand } from './ingestion.contracts';
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
 * Calculates a deterministic, collision-resistant hash of the ingestion command for idempotency.
 */
export function calculateIngestionRequestHash(command: IngestionCommand): string {
  const normalized: Record<string, any> = {
    source: command.source,
    workspaceId: command.workspaceId,
  };

  switch (command.source) {
    case 'doi':
      normalized.doi = (command.doi || '').trim().toLowerCase();
      normalized.collectionId = command.collectionId;
      break;

    case 'url':
      normalized.url = (command.url || '').trim().toLowerCase();
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
      normalized.filename = command.filename;
      normalized.fileHash = command.fileHash;
      normalized.fileUrl = command.fileUrl;
      normalized.fileId = command.fileId;
      normalized.collectionId = command.collectionId;
      if (command.extractedMeta) {
        normalized.extractedMeta = command.extractedMeta;
      }
      break;

    case 'zotero':
      normalized.connectionId = command.connectionId;
      normalized.externalItemKey = command.externalItemKey;
      normalized.collectionId = command.collectionId;
      break;
  }

  return createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
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
      cleanIp.startsWith('127.') ||
      cleanIp.startsWith('10.') ||
      cleanIp.startsWith('192.168.') ||
      cleanIp.startsWith('169.254.') ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(cleanIp)
    ) {
      throw new Error(`SSRF violation: Forbidden IP ${cleanIp}`);
    }
  }
}
