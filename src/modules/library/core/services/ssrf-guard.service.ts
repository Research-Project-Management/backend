import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface SsrfGuardOptions {
  requireHttps?: boolean;
  allowedSchemes?: string[];
  maxRedirects?: number;
}

export const DEFAULT_SAFE_REDIRECT_MAX_HOPS = 5;

export const DEFAULT_BROWSER_FETCH_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 (Academic Client; mailto:contact@flux.academic)',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,application/pdf;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** Thrown when a redirect hop targets an unsafe destination. */
export class UnsafeRedirectError extends Error {}

@Injectable()
export class SsrfGuardService {
  private readonly logger = new Logger(SsrfGuardService.name);
  private readonly defaultAllowedSchemes = new Set(['http:', 'https:']);

  /**
   * Validates a URL against SSRF vectors:
   * 1. Protocol whitelist (HTTP/HTTPS)
   * 2. Hostname blocklist (localhost, internal, metadata)
   * 3. DNS resolution of all A/AAAA records
   * 4. IP blocklist: Loopback, RFC 1918, Link-local, CGNAT, Multicast, Cloud metadata
   */
  async assertSafeUrl(
    rawUrl: string,
    options: SsrfGuardOptions = {},
  ): Promise<URL> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new BadRequestException(`Malformed URL provided: ${rawUrl}`);
    }

    const allowedSchemes = options.allowedSchemes
      ? new Set(options.allowedSchemes)
      : this.defaultAllowedSchemes;

    if (!allowedSchemes.has(url.protocol)) {
      throw new ForbiddenException(
        `Protocol '${url.protocol}' is forbidden. Allowed: ${Array.from(allowedSchemes).join(', ')}`,
      );
    }

    if (options.requireHttps && url.protocol !== 'https:') {
      throw new ForbiddenException(
        `HTTPS is required for external queries, got '${url.protocol}'.`,
      );
    }

    // Disallow userinfo (e.g. http://user:pass@domain) which can be used to obfuscate destinations
    if (url.username || url.password) {
      throw new ForbiddenException(
        'URLs containing user credentials are not allowed.',
      );
    }

    const rawHostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (!rawHostname) {
      throw new BadRequestException('URL must have a valid hostname.');
    }

    // Hostname domain blocklist
    if (
      rawHostname === 'localhost' ||
      rawHostname.endsWith('.localhost') ||
      rawHostname.endsWith('.local') ||
      rawHostname.endsWith('.internal') ||
      rawHostname.endsWith('.cluster.local') ||
      rawHostname === 'metadata.google.internal'
    ) {
      throw new ForbiddenException(
        `Access to local/internal host '${rawHostname}' is denied.`,
      );
    }

    // Block non-standard IPv4 notations (decimal integer, hex, octal)
    if (
      /^\d+$/.test(rawHostname) ||
      /^0x[0-9a-f]+$/i.test(rawHostname) ||
      rawHostname
        .split('.')
        .every((part) => /^\d+$/.test(part) || /^0x[0-9a-f]+$/i.test(part))
    ) {
      if (isIP(rawHostname) !== 4) {
        throw new ForbiddenException(
          `Non-standard IPv4 notation '${rawHostname}' is forbidden.`,
        );
      }
    }

    // If direct IP literal
    if (isIP(rawHostname)) {
      if (this.isPrivateOrReservedIp(rawHostname)) {
        throw new ForbiddenException(
          `Direct access to private or reserved IP address '${rawHostname}' is forbidden.`,
        );
      }
      return url;
    }

    // Resolve all DNS records (A and AAAA)
    try {
      const addresses = await lookup(rawHostname, { all: true });
      if (!addresses || addresses.length === 0) {
        throw new BadRequestException(
          `Unable to resolve host '${rawHostname}'.`,
        );
      }

      for (const record of addresses) {
        if (this.isPrivateOrReservedIp(record.address)) {
          this.logger.warn(
            `SSRF attempt detected: ${rawHostname} resolved to private/reserved IP ${record.address}`,
          );
          throw new ForbiddenException(
            `Host '${rawHostname}' resolves to a private or reserved IP address.`,
          );
        }
      }
    } catch (err: unknown) {
      if (
        err instanceof ForbiddenException ||
        err instanceof BadRequestException
      ) {
        throw err;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`DNS resolution failed for ${rawHostname}: ${errMsg}`);
      throw new BadRequestException(`Unable to resolve host '${rawHostname}'.`);
    }

    return url;
  }

  /**
   * Shared multi-hop redirect fetch loop that validates every hop using the provided validator
   * (or this.assertSafeUrl) and returns both the final Response and resolved finalUrl.
   */
  static async executeSafeRedirectFetch(
    startUrl: string,
    init: RequestInit = {},
    options: {
      maxRedirects?: number;
      validateUrl?: (url: string) => Promise<unknown>;
      beforeHop?: (url: string, signal?: AbortSignal | null) => Promise<void>;
    } = {},
  ): Promise<{ response: Response; finalUrl: string }> {
    const maxRedirects = options.maxRedirects ?? 5;
    let currentUrl = startUrl;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (options.beforeHop) {
        await options.beforeHop(currentUrl, init.signal);
      }

      const effectiveSignal = init.signal ?? AbortSignal.timeout(15000);
      const res = await fetch(currentUrl, {
        ...init,
        signal: effectiveSignal,
        redirect: 'manual',
      });

      const status = res.status;
      const isRedirect =
        typeof status === 'number' && status >= 300 && status < 400;
      const location = isRedirect ? res.headers?.get?.('location') : null;

      if (!location) {
        return { response: res, finalUrl: currentUrl };
      }

      try {
        await res.body?.cancel();
      } catch {
        /* ignore body cancel errors on redirect hops */
      }

      if (hop >= maxRedirects) {
        throw new ForbiddenException(
          `SSRF Protection: Maximum redirect limit (${maxRedirects}) exceeded.`,
        );
      }

      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new BadRequestException(
          `Invalid redirect URL in Location header: ${location}`,
        );
      }

      if (!/^https?:$/i.test(new URL(nextUrl).protocol)) {
        throw new ForbiddenException(
          `Redirect to non-HTTP scheme rejected: "${nextUrl}"`,
        );
      }

      if (options.validateUrl) {
        await options.validateUrl(nextUrl);
      }

      currentUrl = nextUrl;
    }

    throw new ForbiddenException('Too many redirects.');
  }

  /**
   * Safe fetch that validates the destination URL and all subsequent redirect hops
   * against SSRF protections with redirect: 'manual'.
   */
  async safeFetch(
    rawUrl: string,
    init: RequestInit = {},
    options: SsrfGuardOptions = {},
  ): Promise<Response> {
    const { response } = await this.safeFetchWithRedirects(
      rawUrl,
      init,
      options,
    );
    return response;
  }

  async safeFetchWithRedirects(
    rawUrl: string,
    init: RequestInit = {},
    options: SsrfGuardOptions & {
      beforeHop?: (url: string, signal?: AbortSignal | null) => Promise<void>;
    } = {},
  ): Promise<{ response: Response; finalUrl: string }> {
    await this.assertSafeUrl(rawUrl, options);
    return SsrfGuardService.executeSafeRedirectFetch(rawUrl, init, {
      maxRedirects: options.maxRedirects,
      validateUrl: (nextUrl) => this.assertSafeUrl(nextUrl, options),
      beforeHop: options.beforeHop,
    });
  }

  /**
   * Checks if an IP is in loopback, RFC 1918 private, link-local, CGNAT, multicast,
   * cloud metadata, or reserved ranges.
   */
  isPrivateOrReservedIp(ip: string): boolean {
    const normalized = ip.toLowerCase().trim();

    // IPv4 Checks
    if (normalized.includes('.')) {
      const parts = normalized.split('.').map((p) => parseInt(p, 10));
      if (
        parts.length !== 4 ||
        parts.some((p) => isNaN(p) || p < 0 || p > 255)
      ) {
        return true;
      }

      // 0.0.0.0/8 (Current network)
      if (parts[0] === 0) return true;

      // 10.0.0.0/8 (RFC 1918 Private)
      if (parts[0] === 10) return true;

      // 100.64.0.0/10 (RFC 6598 Carrier-Grade NAT)
      if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;

      // 100.100.100.200 (Alibaba Cloud Metadata)
      if (
        parts[0] === 100 &&
        parts[1] === 100 &&
        parts[2] === 100 &&
        parts[3] === 200
      )
        return true;

      // 127.0.0.0/8 (Loopback)
      if (parts[0] === 127) return true;

      // 169.254.0.0/16 (Link-Local, includes 169.254.169.254 Cloud Metadata)
      if (parts[0] === 169 && parts[1] === 254) return true;

      // 172.16.0.0/12 (RFC 1918 Private)
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;

      // 192.0.0.0/24 (IETF Protocol Assignments)
      if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;

      // 192.0.2.0/24 (Documentation / TEST-NET-1)
      if (parts[0] === 192 && parts[1] === 0 && parts[2] === 2) return true;

      // 192.168.0.0/16 (RFC 1918 Private)
      if (parts[0] === 192 && parts[1] === 168) return true;

      // 198.18.0.0/15 (Benchmarking)
      if (parts[0] === 198 && (parts[1] === 18 || parts[1] === 19)) return true;

      // 198.51.100.0/24 (Documentation / TEST-NET-2)
      if (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) return true;

      // 203.0.113.0/24 (Documentation / TEST-NET-3)
      if (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) return true;

      // 224.0.0.0/4 (Multicast)
      if (parts[0] >= 224 && parts[0] <= 239) return true;

      // 240.0.0.0/4 (Reserved / Future Use, includes broadcast 255.255.255.255)
      if (parts[0] >= 240) return true;

      return false;
    }

    // IPv6 Checks
    if (normalized === '::1' || normalized === '::') return true;

    // Discard prefix (100::/64 RFC 6666)
    if (normalized.startsWith('100:')) return true;

    // Documentation prefix (2001:db8::/32 RFC 3849)
    if (normalized.startsWith('2001:db8:') || normalized.startsWith('2001:0db8:')) return true;

    // 6to4 prefix (2002::/16 RFC 3056) - extracts embedded IPv4 in 2nd and 3rd 16-bit blocks
    if (normalized.startsWith('2002:')) {
      const parts = normalized.split(':');
      if (parts.length >= 3) {
        const h1 = parseInt(parts[1], 16);
        const h2 = parseInt(parts[2], 16);
        if (!isNaN(h1) && !isNaN(h2)) {
          const b1 = (h1 >> 8) & 0xff;
          const b2 = h1 & 0xff;
          const b3 = (h2 >> 8) & 0xff;
          const b4 = h2 & 0xff;
          if (this.isPrivateOrReservedIp(`${b1}.${b2}.${b3}.${b4}`)) {
            return true;
          }
        }
      }
    }

    // NAT64 Well-Known Prefix (64:ff9b::/96 RFC 6052)
    if (normalized.startsWith('64:ff9b::') || normalized.startsWith('0064:ff9b::')) {
      const remainder = normalized.replace(/^(?:00)?64:ff9b::/i, '');
      if (isIP(remainder) === 4) {
        return this.isPrivateOrReservedIp(remainder);
      }
      const hexParts = remainder.split(':');
      if (hexParts.length === 2) {
        const h1 = parseInt(hexParts[0], 16);
        const h2 = parseInt(hexParts[1], 16);
        if (!isNaN(h1) && !isNaN(h2)) {
          const b1 = (h1 >> 8) & 0xff;
          const b2 = h1 & 0xff;
          const b3 = (h2 >> 8) & 0xff;
          const b4 = h2 & 0xff;
          return this.isPrivateOrReservedIp(`${b1}.${b2}.${b3}.${b4}`);
        }
      }
      return true; // Fail closed for NAT64 gateway prefix
    }

    // IPv4-compatible IPv6 (::x.x.x.x or ::hhhh:hhhh)
    if (normalized.startsWith('::') && !normalized.startsWith('::ffff:')) {
      const remainder = normalized.substring(2);
      if (isIP(remainder) === 4) {
        return this.isPrivateOrReservedIp(remainder);
      }
      const hexParts = remainder.split(':');
      if (hexParts.length === 2) {
        const h1 = parseInt(hexParts[0], 16);
        const h2 = parseInt(hexParts[1], 16);
        if (!isNaN(h1) && !isNaN(h2)) {
          const b1 = (h1 >> 8) & 0xff;
          const b2 = h1 & 0xff;
          const b3 = (h2 >> 8) & 0xff;
          const b4 = h2 & 0xff;
          return this.isPrivateOrReservedIp(`${b1}.${b2}.${b3}.${b4}`);
        }
      }
    }

    // IPv4-mapped IPv6 (::ffff:x.x.x.x or ::ffff:hhhh:hhhh in hex)
    if (normalized.startsWith('::ffff:')) {
      const remainder = normalized.substring(7);
      if (isIP(remainder) === 4) {
        return this.isPrivateOrReservedIp(remainder);
      }
      // Hex representation e.g. ::ffff:7f00:1 or ::ffff:7f00:0001
      const hexParts = remainder.split(':');
      if (hexParts.length === 2) {
        const h1 = parseInt(hexParts[0], 16);
        const h2 = parseInt(hexParts[1], 16);
        if (
          !isNaN(h1) &&
          !isNaN(h2) &&
          h1 >= 0 &&
          h1 <= 0xffff &&
          h2 >= 0 &&
          h2 <= 0xffff
        ) {
          const b1 = (h1 >> 8) & 0xff;
          const b2 = h1 & 0xff;
          const b3 = (h2 >> 8) & 0xff;
          const b4 = h2 & 0xff;
          return this.isPrivateOrReservedIp(`${b1}.${b2}.${b3}.${b4}`);
        }
      }
      return true; // Fail closed for any other ::ffff: pattern
    }

    // Link-local (fe80::/10)
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    ) {
      return true;
    }

    // Site-local (fec0::/10 RFC 3879 deprecated)
    if (
      normalized.startsWith('fec') ||
      normalized.startsWith('fed') ||
      normalized.startsWith('fee') ||
      normalized.startsWith('fef')
    ) {
      return true;
    }

    // Unique Local Addresses (fc00::/7 -> fc00:: to fdff::)
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
      return true;
    }

    // Multicast (ff00::/8)
    if (normalized.startsWith('ff')) {
      return true;
    }

    return false;
  }
}
