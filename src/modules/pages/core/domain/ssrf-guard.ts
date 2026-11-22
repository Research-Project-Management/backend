/**
 * modules/manuscripts/core/domain/ssrf-guard.ts
 *
 * Shared Security Domain Policy for Manuscripts: Validates external URLs to prevent
 * Server-Side Request Forgery (SSRF) attacks targeting cloud metadata (169.254.169.254),
 * internal loopback (127.0.0.1), private VPC networks (RFC 1918), and internal hostnames.
 */

import { PagesDomainError } from './pages-domain.error';

export class SsrfSecurityException extends PagesDomainError {
  constructor(message: string) {
    super(`SSRF Protection: ${message}`, {
      code: 'SSRF_SECURITY_VIOLATION',
      statusCode: 403,
    });
  }
}
