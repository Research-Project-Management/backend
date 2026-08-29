import { ConflictException } from '@nestjs/common';
import {
  MetadataRoutingPolicy,
  METADATA_POLICY_VERSION,
} from '@/modules/library/ingestion/metadata/metadata.policy';

describe('MetadataRoutingPolicy', () => {
  describe('getTiers — routing matrix', () => {
    it('DOI: CrossRef is authoritative; S2/OpenAlex/Unpaywall as enrichment', () => {
      const tiers = MetadataRoutingPolicy.getTiers('DOI');
      expect(tiers.authoritative).toContain('CrossRef');
      expect(tiers.enrichment).toContain('SemanticScholar');
      expect(tiers.enrichment).toContain('Unpaywall');
      expect(tiers.fallback).toContain('OpenAlex');
    });

    it('ARXIV: arXiv is authoritative; S2/OpenAlex enrichment', () => {
      const tiers = MetadataRoutingPolicy.getTiers('ARXIV');
      expect(tiers.authoritative).toContain('arXiv');
      expect(tiers.enrichment).toContain('SemanticScholar');
    });

    it('PMID: PubMed is authoritative', () => {
      const tiers = MetadataRoutingPolicy.getTiers('PMID');
      expect(tiers.authoritative).toContain('PubMed');
      expect(tiers.enrichment).toContain('SemanticScholar');
    });

    it('ISBN: OpenLibrary is authoritative', () => {
      const tiers = MetadataRoutingPolicy.getTiers('ISBN');
      expect(tiers.authoritative).toContain('OpenLibrary');
    });

    it('URL: SemanticScholar handles URL lookup', () => {
      const tiers = MetadataRoutingPolicy.getTiers('URL');
      expect(tiers.authoritative).toContain('SemanticScholar');
    });

    it('TITLE: SemanticScholar primary, CrossRef+OpenAlex fallback', () => {
      const tiers = MetadataRoutingPolicy.getTiers('TITLE');
      expect(tiers.authoritative).toContain('SemanticScholar');
      expect(tiers.fallback).toContain('CrossRef');
      expect(tiers.fallback).toContain('OpenAlex');
    });
  });

  describe('validateUrl — SSRF prevention', () => {
    const expectBlocked = (url: string) => {
      expect(() => MetadataRoutingPolicy.validateUrl(url)).toThrow(
        ConflictException,
      );
    };
    const expectAllowed = (url: string) => {
      expect(() => MetadataRoutingPolicy.validateUrl(url)).not.toThrow();
    };

    it('blocks localhost', () => expectBlocked('http://localhost/api'));
    it('blocks 127.0.0.1', () => expectBlocked('http://127.0.0.1/'));
    it('blocks 127.x.x.x', () => expectBlocked('http://127.10.20.30/'));
    it('blocks 10.x.x.x private', () => expectBlocked('http://10.0.0.1/'));
    it('blocks 172.16.x.x private', () => expectBlocked('http://172.16.0.1/'));
    it('blocks 172.31.x.x private', () =>
      expectBlocked('http://172.31.255.255/'));
    it('blocks 192.168.x.x private', () =>
      expectBlocked('http://192.168.1.1/'));
    it('blocks link-local 169.254.x.x', () =>
      expectBlocked('http://169.254.0.1/'));
    it('blocks AWS metadata IP', () =>
      expectBlocked('http://169.254.169.254/'));
    it('blocks Alibaba Cloud metadata', () =>
      expectBlocked('http://100.100.100.200/'));
    it('blocks IPv6 ::1', () => expectBlocked('http://[::1]/'));
    it('blocks non-http scheme', () => expectBlocked('file:///etc/passwd'));
    it('blocks ftp scheme', () => expectBlocked('ftp://example.com/'));
    it('allows public https URL', () =>
      expectAllowed('https://www.nature.com/articles/foo'));
    it('allows public http URL', () =>
      expectAllowed('http://api.example.com/foo'));
    it('does not throw for non-URL strings (handled by classifier)', () =>
      expectAllowed('10.1234/some-doi')); // bare DOI — not a URL
  });

  it('PARALLEL_LIMIT is 3', () => {
    expect(MetadataRoutingPolicy.PARALLEL_LIMIT).toBe(3);
  });

  it('METADATA_POLICY_VERSION is a positive integer', () => {
    expect(METADATA_POLICY_VERSION).toBeGreaterThan(0);
  });
});
