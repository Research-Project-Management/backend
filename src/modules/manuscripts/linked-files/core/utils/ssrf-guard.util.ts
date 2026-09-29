/**
 * linked-files/core/utils/ssrf-guard.util.ts
 *
 * Security Hardening: Validates external URLs to prevent Server-Side Request Forgery (SSRF)
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

/**
 * Checks whether an IPv4 address belongs to a private, loopback, link-local,
 * or cloud metadata subnet.
 */
export function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return true; // Malformed IP is treated as unsafe
  }

  const [a, b] = parts;

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;
  // 10.0.0.0/8 (Private)
  if (a === 10) return true;
  // 100.64.0.0/10 (Shared Address Space / CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-Local / AWS/GCP/Azure Cloud Metadata)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (Private)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (Private)
  if (a === 192 && b === 168) return true;
  // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved)
  if (a >= 224) return true;

  return false;
}

/**
 * Checks whether an IPv6 address belongs to a private, loopback, or link-local subnet.
 */
export function isPrivateOrReservedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fe80:')) return true; // Link-local
  if (normalized.startsWith('fc00:') || normalized.startsWith('fd'))
    return true; // Unique local
  return false;
}

/**
 * Validates a target URL against SSRF vulnerabilities.
 * Resolves DNS to ensure domains cannot point to private IP spaces (DNS Rebinding).
 */
export async function assertSafeExternalUrl(rawUrl: string): Promise<URL> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new SsrfSecurityException('Invalid URL format');
  }

  // 1. Only allow HTTP and HTTPS
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new SsrfSecurityException(
      `Unsupported URL protocol "${parsedUrl.protocol}" (only http/https allowed)`,
    );
  }

  const hostname = parsedUrl.hostname.toLowerCase();

  // 2. Reject well-known local/internal hostnames
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

  // 3. If hostname is directly an IP literal
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

  // 4. Resolve DNS to prevent DNS rebinding attacks targeting private networks
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
  } catch (err: any) {
    if (err instanceof SsrfSecurityException) throw err;
    throw new SsrfSecurityException(
      `Could not resolve hostname "${hostname}": ${err.message}`,
    );
  }

  return parsedUrl;
}
