import { isIP } from 'net';

export interface UrlValidationResult {
  isSafe: boolean;
  reason?: string;
  normalizedUrl?: string;
}

export function validateExternalUrl(urlStr: string): UrlValidationResult {
  if (!urlStr || typeof urlStr !== 'string') {
    return { isSafe: false, reason: 'Empty or invalid URL' };
  }

  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { isSafe: false, reason: 'Malformed URL format' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      isSafe: false,
      reason: `Unsupported protocol (${parsed.protocol}). Only http: and https: are allowed.`,
    };
  }

  const hostname = parsed.hostname.toLowerCase();

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan')
  ) {
    return {
      isSafe: false,
      reason: `SSRF Violation: Forbidden internal/local domain (${hostname})`,
    };
  }

  const cleanIp = hostname.replace(/^\[|\]$/g, '');
  const ipType = isIP(cleanIp);
  if (ipType === 4) {
    if (isPrivateOrRestrictedIPv4(cleanIp)) {
      return {
        isSafe: false,
        reason: `SSRF Violation: Forbidden private or metadata IPv4 address (${hostname})`,
      };
    }
  } else if (ipType === 6) {
    if (isPrivateOrRestrictedIPv6(cleanIp)) {
      return {
        isSafe: false,
        reason: `SSRF Violation: Forbidden private or metadata IPv6 address (${hostname})`,
      };
    }
  }

  return { isSafe: true, normalizedUrl: parsed.toString() };
}

function isPrivateOrRestrictedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true;
  }

  const [a, b] = parts;
  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;

  return false;
}

export class UrlSecurityValidator {
  validateExternalUrl(urlStr: string): UrlValidationResult {
    return validateExternalUrl(urlStr);
  }
}

function isPrivateOrRestrictedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  ) {
    return true;
  }
  if (normalized.startsWith('::ffff:')) {
    const v4 = normalized.substring(7);
    return isPrivateOrRestrictedIPv4(v4);
  }
  return false;
}
