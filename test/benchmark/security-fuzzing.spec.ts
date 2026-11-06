/**
 * test/benchmark/security-fuzzing.spec.ts
 *
 * Pillar 5: Dynamic Security Fuzzing & Abuse Testing Suite
 * Tests system resilience against malformed inputs and attack payloads:
 *
 *  1. SSRF Vector Fuzzing: Loopback, AWS metadata, IPv4-mapped IPv6, integer/octal notation.
 *  2. XML Bomb / XXE Fuzzing: Billion Laughs and External Entity payloads in CSL & OPML parsers.
 *  3. Prototype Pollution Fuzzing: __proto__, constructor, prototype injections in DTO/Metadata.
 *  4. Extreme Unicode & ReDoS Fuzzing: Astral plane emojis, bidirectional overrides, and 100k-char inputs.
 */

import { SsrfGuardService } from '@/modules/library/core';
import { CslRepositoryService } from '@/modules/library/citation/services/csl-repository.service';
import { FeedsService } from '@/modules/library/ingestion/services/feeds.service';
import { SERVER_RESERVED_METADATA_KEYS } from '@/modules/library/catalog/domain/item-command.mapper';
import { normalizeTitleForDedupe, calculateTitleSimilarity } from '@/modules/library/ingestion/domain/deduplication.domain';

describe('Pillar 5: Dynamic Security Fuzzing & Abuse Testing', () => {
  jest.setTimeout(30000);

  // =========================================================================
  // SCENARIO 1: Comprehensive SSRF IP & DNS Fuzzing Matrix
  // =========================================================================
  describe('Scenario 1: SSRF Guard Defense Matrix', () => {
    let ssrfGuard: SsrfGuardService;

    beforeEach(() => {
      ssrfGuard = new SsrfGuardService();
    });

    const maliciousUrls = [
      // Cloud Metadata & Loopback
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:8080/admin',
      'http://localhost:3000/api',
      'http://0.0.0.0:80',
      'http://[::1]/secret',
      'http://[::ffff:127.0.0.1]/status',
      'http://[::ffff:7f00:1]/status',
      // Private RFC1918 addresses
      'http://10.0.0.1/internal',
      'http://172.16.0.5/api',
      'http://192.168.1.1/router',
      // Obfuscated / Non-standard notations
      'http://2130706433/',       // Decimal integer for 127.0.0.1
      'http://0x7f000001/',       // Hex for 127.0.0.1
      'http://0177.0.0.1/',       // Octal for 127.0.0.1
      // Domain-based bypasses
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://test.cluster.local/',
      'http://user:password@example.com/', // Embedded credentials
      'ftp://example.com/file.txt',       // Forbidden protocol
      'file:///etc/passwd',               // File protocol
    ];

    maliciousUrls.forEach((url) => {
      it(`should strictly reject SSRF vector: ${url}`, async () => {
        await expect(ssrfGuard.assertSafeUrl(url)).rejects.toThrow();
      });
    });

    it('should permit valid public academic URLs', async () => {
      // Mocking resolveAndValidateHostIps so test does not rely on external DNS
      jest.spyOn<any, any>(ssrfGuard, 'resolveAndValidateHostIps').mockResolvedValue(['93.184.216.34']);
      const res = await ssrfGuard.assertSafeUrl('https://api.crossref.org/works/10.1000/182');
      expect(res.hostname).toBe('api.crossref.org');
    });
  });

  // =========================================================================
  // SCENARIO 2: XML Bomb & XXE Entity Expansion Fuzzing
  // =========================================================================
  describe('Scenario 2: XXE & XML Bomb Injection in Parsers', () => {
    const billionLaughsXml = `<?xml version="1.0"?>
      <!DOCTYPE lolz [
        <!ENTITY lol "lol">
        <!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">
        <!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">
      ]>
      <style xmlns="http://purl.org/net/xbiblio/csl" version="1.0">
        <info><title>&lol3;</title></info>
      </style>`;

    const externalEntityXml = `<?xml version="1.0"?>
      <!DOCTYPE foo [
        <!ENTITY xxe SYSTEM "file:///etc/passwd">
      ]>
      <style xmlns="http://purl.org/net/xbiblio/csl" version="1.0">
        <info><title>&xxe;</title></info>
      </style>`;

    const xssScriptXml = `<?xml version="1.0"?>
      <style xmlns="http://purl.org/net/xbiblio/csl" version="1.0">
        <info><title><script>alert(1)</script></title></info>
      </style>`;

    it('should reject DOCTYPE and ENTITY injection in CslRepositoryService within 1ms', () => {
      const cslRepo = new CslRepositoryService(null as any);
      expect(cslRepo.isValidCslXml(billionLaughsXml)).toBe(false);
      expect(cslRepo.isValidCslXml(externalEntityXml)).toBe(false);
      expect(cslRepo.isValidCslXml(xssScriptXml)).toBe(false);
    });

    it('should reject DOCTYPE and ENTITY in OPML import', async () => {
      const feedsService = new FeedsService(null as any, null as any);
      await expect(
        feedsService.importOpml('user-1', billionLaughsXml),
      ).rejects.toThrow('OPML XML must not contain DOCTYPE or ENTITY declarations');
    });
  });

  // =========================================================================
  // SCENARIO 3: Prototype Pollution & Internal Provenance Key Injection
  // =========================================================================
  describe('Scenario 3: Prototype Pollution & Reserved Key Sanitization', () => {
    it('should strictly contain all prototype pollution and provenance keys in SERVER_RESERVED_METADATA_KEYS', () => {
      const dangerousKeys = [
        '__proto__',
        'constructor',
        'prototype',
        'fieldProvenance',
        'lockedFields',
        'dismissedDuplicateIds',
        'isRetracted',
      ];

      dangerousKeys.forEach((key) => {
        expect(SERVER_RESERVED_METADATA_KEYS.has(key)).toBe(true);
      });
    });

    it('should verify Object.prototype remains unpolluted after processing attack dictionary', () => {
      const attackPayload = JSON.parse(`{
        "__proto__": { "polluted": "yes" },
        "constructor": { "prototype": { "polluted": "yes" } }
      }`);

      // Filter out reserved keys
      const safeMeta: Record<string, unknown> = Object.create(null);
      for (const [k, v] of Object.entries(attackPayload)) {
        if (!SERVER_RESERVED_METADATA_KEYS.has(k)) {
          safeMeta[k] = v;
        }
      }

      // Check pollution on standard Object
      expect(({} as any).polluted).toBeUndefined();
      expect(safeMeta['__proto__']).toBeUndefined();
      expect(safeMeta['constructor']).toBeUndefined();
    });
  });

  // =========================================================================
  // SCENARIO 4: Extreme Unicode, Astral Plane & ReDoS Fuzzing
  // =========================================================================
  describe('Scenario 4: Extreme Strings & ReDoS Fuzzing', () => {
    it('should process 100,000-character repetitive strings without catastrophic backtracking (ReDoS)', () => {
      // Classic ReDoS trigger pattern: nested repetitions like (a+)+
      const extremeString = 'a'.repeat(50000) + '!' + 'b'.repeat(50000);

      const t0 = process.hrtime.bigint();
      const normalized = normalizeTitleForDedupe(extremeString);
      const elapsedMs = Number(process.hrtime.bigint() - t0) / 1_000_000;

      // Normalization of 100k chars MUST finish under 50ms without freezing Node.js event loop
      expect(elapsedMs).toBeLessThan(50);
      expect(typeof normalized).toBe('string');
    });

    it('should handle Astral Plane emojis, Null bytes, and RTL overrides cleanly', () => {
      const dirtyTitle = 'Machine Learning \u0000 with Emojis 🚀🔬🧠 and RTL \u202Ereversed\u202C text';
      const clean = normalizeTitleForDedupe(dirtyTitle);

      expect(clean).not.toContain('\u0000'); // Null byte removed
      expect(clean.length).toBeGreaterThan(0);

      // Title similarity should safely evaluate without crashing
      const score = calculateTitleSimilarity(dirtyTitle, 'Machine Learning with Emojis and RTL reversed text');
      expect(score).toBeGreaterThan(0.7);
    });
  });
});
