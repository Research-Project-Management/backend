/**
 * linked-files/domain/ssrf-guard.ts
 *
 * Security Domain Policy: Validates external URLs to prevent Server-Side Request Forgery (SSRF)
 * attacks targeting cloud metadata (169.254.169.254), internal loopback (127.0.0.1),
 * private VPC networks (RFC 1918), and internal hostnames.
 */

import { lookup } from 'dns/promises';
import { isIP } from 'net';

export class SsrfSecurityException extends Error {
  constructor(message: string) {
    super(`SSRF Protection: ${message}`);
    this.name = 'SsrfSecurityException';
  }
}

export function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true;
  }

  const [a, b] = parts;

  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;

  return false;
}

export function isPrivateOrReservedIPv6(ip: string): boolean {
  const normalized = ip
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .trim();
  if (
    normalized === '::1' ||
    normalized === '::' ||
    /^(?:0+:){7}0*1$/.test(normalized) ||
    /^(?:0+:){7}0+$/.test(normalized)
  ) {
    return true;
  }
  if (/^fe[89ab][0-9a-f]:/.test(normalized) || normalized.startsWith('fe80:')) {
    return true;
  }
  if (
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('ff')
  ) {
    return true;
  }

  const v4MappedMatch = normalized.match(/^(?:::ffff:|(?:0+:){5}ffff:)(.+)$/i);
  if (v4MappedMatch) {
    const tail = v4MappedMatch[1];
    if (tail.includes('.')) {
      return isPrivateOrReservedIPv4(tail);
    }
    const hexParts = tail.split(':');
    if (hexParts.length === 2) {
      const hi = parseInt(hexParts[0], 16);
      const lo = parseInt(hexParts[1], 16);
      if (!isNaN(hi) && !isNaN(lo)) {
        const ipv4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateOrReservedIPv4(ipv4);
      }
    }
    return true;
  }

  return false;
}

export async function assertSafeExternalUrl(rawUrl: string): Promise<URL> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new SsrfSecurityException('Invalid URL format');
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new SsrfSecurityException(
      `Unsupported URL protocol "${parsedUrl.protocol}" (only http/https allowed)`,
    );
  }

  const rawHostname = parsedUrl.hostname.toLowerCase();
  const hostname = rawHostname.replace(/^\[|\]$/g, '');

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.corp')
  ) {
    throw new SsrfSecurityException(
      `Access to internal hostname "${hostname}" is forbidden`,
    );
  }

  const ipVersion = isIP(hostname);
  if (ipVersion === 4 && isPrivateOrReservedIPv4(hostname)) {
    throw new SsrfSecurityException(
      `Access to private IP space "${hostname}" is forbidden`,
    );
  }
  if (ipVersion === 6 && isPrivateOrReservedIPv6(hostname)) {
    throw new SsrfSecurityException(
      `Access to private IPv6 space "${hostname}" is forbidden`,
    );
  }

  try {
    const addresses = await lookup(hostname, { all: true });
    for (const addr of addresses) {
      if (addr.family === 4 && isPrivateOrReservedIPv4(addr.address)) {
        throw new SsrfSecurityException(
          `Domain "${hostname}" resolves to protected private IP "${addr.address}"`,
        );
      }
      if (addr.family === 6 && isPrivateOrReservedIPv6(addr.address)) {
        throw new SsrfSecurityException(
          `Domain "${hostname}" resolves to protected private IPv6 "${addr.address}"`,
        );
      }
    }
  } catch (err: unknown) {
    if (err instanceof SsrfSecurityException) throw err;
    throw new SsrfSecurityException(
      `Could not resolve hostname "${hostname}": ${(err as Error)?.message}`,
    );
  }

  return parsedUrl;
}
