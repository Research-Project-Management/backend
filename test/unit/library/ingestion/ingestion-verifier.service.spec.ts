import {
  IngestionVerifierService,
  PdfFingerprint,
} from '@/modules/library/ingestion/services/ingestion-verifier.service';
import { ItemMetadata } from '@/modules/library/ingestion/types/metadata.types';

describe('IngestionVerifierService', () => {
  let verifier: IngestionVerifierService;

  beforeEach(() => {
    verifier = new IngestionVerifierService();
  });

  describe('extractFingerprint', () => {
    it('extracts fingerprint from metadata with authors array', () => {
      const meta: ItemMetadata = {
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani', 'Noam Shazeer'],
        doi: '10.48550/arXiv.1706.03762',
        arxivId: '1706.03762',
        year: 2017,
      };

      const fp = verifier.extractFingerprint(
        meta,
        'first page raw text sample',
      );
      expect(fp.title).toBe('Attention Is All You Need');
      expect(fp.firstAuthorSurname).toBe('vaswani');
      expect(fp.doi).toBe('10.48550/arXiv.1706.03762');
      expect(fp.arxivId).toBe('1706.03762');
      expect(fp.year).toBe(2017);
      expect(fp.firstPageText).toBe('first page raw text sample');
    });

    it('extracts surname from creators array', () => {
      const meta: ItemMetadata = {
        title: 'Deep Residual Learning',
        creators: [{ lastName: 'He', firstName: 'Kaiming' }],
        year: 2015,
      };

      const fp = verifier.extractFingerprint(meta);
      expect(fp.firstAuthorSurname).toBe('he');
    });
  });

  describe('verifyWebCandidate', () => {
    const fingerprint: PdfFingerprint = {
      title: 'Attention Is All You Need',
      doi: '10.48550/arXiv.1706.03762',
      arxivId: '1706.03762',
      firstAuthorSurname: 'vaswani',
      year: 2017,
      firstPageText:
        'Attention Is All You Need Ashish Vaswani Noam Shazeer 1706.03762',
    };

    it('scores 1.0 (COMPLETE) when DOI, Title, Author, Year, and Venue all match', () => {
      const candidate: ItemMetadata = {
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar'],
        doi: '10.48550/arXiv.1706.03762',
        arxivId: '1706.03762',
        year: 2017,
        journal: 'Advances in Neural Information Processing Systems (NeurIPS)',
        abstract:
          'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks that include an encoder and a decoder.',
      };

      const res = verifier.verifyWebCandidate(
        fingerprint,
        candidate,
        'web:arxiv.org',
      );
      expect(res.verificationScore).toBe(1.0);
      expect(res.isVerified).toBe(true);
      expect(res.status).toBe('COMPLETE');
      expect(res.missingFields).toHaveLength(0);
      expect(res.matchedSignals).toContain('identifier_doi_verified');
      expect(res.matchedSignals).toContain('first_author_surname_matched');
      expect(res.matchedSignals).toContain('publication_year_matched');
      expect(res.fieldProvenance.title.verified).toBe(true);
      expect(res.fieldProvenance.authors.verified).toBe(true);
      expect(res.fieldProvenance.doi.verified).toBe(true);
    });

    it('returns PARTIAL when candidate is verified (>= 0.80) but lacks journal/venue or abstract', () => {
      const candidate: ItemMetadata = {
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani'],
        doi: '10.48550/arXiv.1706.03762',
        year: 2017,
        // missing journal/venue and abstract
      };

      const res = verifier.verifyWebCandidate(fingerprint, candidate);
      expect(res.verificationScore).toBe(1.0);
      expect(res.isVerified).toBe(true);
      expect(res.status).toBe('PARTIAL');
      expect(res.missingFields).toContain('journal/venue');
      expect(res.missingFields).toContain('abstract');
    });

    it('returns NEEDS_REVIEW when score is between 0.50 and 0.79 (e.g. title mismatch)', () => {
      const candidate: ItemMetadata = {
        title: 'Completely Different Title But Sharing Identifier',
        doi: '10.48550/arXiv.1706.03762',
        authors: ['Random Person'],
        year: 2024,
      };

      // Identifier matches (+0.40), title fails (< 0.70), author fails, year fails (diff > 1) -> Score = 0.40 -> FAILED
      const res = verifier.verifyWebCandidate(fingerprint, candidate);
      expect(res.isVerified).toBe(false);
      expect(res.status).toBe('NEEDS_REVIEW');
      expect(res.warnings).toContain('cited_paper_doi_mismatch');
      expect(res.isDisambiguationMismatch).toBe(true);
    });

    it('returns FAILED when candidate has no title or score < 0.30', () => {
      const candidate: ItemMetadata = {
        title: '',
        year: 1990,
      };

      const res = verifier.verifyWebCandidate(fingerprint, candidate);
      expect(res.isVerified).toBe(false);
      expect(res.status).toBe('FAILED');
    });
  });

  describe('evaluateLocalResult', () => {
    it('returns COMPLETE when all core bibliographic fields are present', () => {
      const meta: ItemMetadata = {
        title: 'High Performance In-Process Metadata Extraction',
        authors: ['John Doe', 'Jane Smith'],
        doi: '10.1145/3377811.3380321',
        year: 2020,
        journal: 'ACM Transactions on Computer Systems',
        abstract:
          'This paper presents a scalable, zero-network architecture for in-process academic document extraction.',
      };

      const res = verifier.evaluateLocalResult(meta, 'XMP_BINARY', 1.0);
      expect(res.status).toBe('COMPLETE');
      expect(res.isVerified).toBe(true);
      expect(res.missingFields).toHaveLength(0);
      expect(res.fieldProvenance.title.source).toBe('XMP_BINARY');
    });

    it('returns PARTIAL when local paper is an arXiv preprint lacking journal/venue', () => {
      const meta: ItemMetadata = {
        title: 'Deep Residual Learning for Image Recognition',
        authors: ['Kaiming He', 'Xiangyu Zhang', 'Shaoqing Ren', 'Jian Sun'],
        arxivId: '1512.03385',
        doi: '10.48550/arXiv.1512.03385',
        year: 2015,
        abstract: 'Deeper neural networks are more difficult to train.',
      };

      const res = verifier.evaluateLocalResult(meta, 'HYBRID', 0.9);
      expect(res.status).toBe('PARTIAL');
      expect(res.missingFields).toContain('journal/venue');
      expect(res.isVerified).toBe(true);
    });

    it('returns FAILED for generic or missing title', () => {
      const meta: ItemMetadata = {
        title: 'Uploaded Document',
        authors: ['Unknown'],
      };

      const res = verifier.evaluateLocalResult(meta, 'LOCAL', 0.2);
      expect(res.status).toBe('FAILED');
      expect(res.warnings).toContain('missing_or_corrupt_title');
    });
  });

  describe('detectBlockedStatus', () => {
    it('detects HTTP 403 and 429 as blocked', () => {
      const res403 = verifier.detectBlockedStatus(
        'https://biorxiv.org',
        '',
        403,
      );
      expect(res403.isBlocked).toBe(true);
      expect(res403.wafKind).toBe('HTTP_403_FORBIDDEN');
      expect(res403.promptUploadPdf).toBe(true);

      const res429 = verifier.detectBlockedStatus(
        'https://example.com',
        '',
        429,
      );
      expect(res429.isBlocked).toBe(true);
      expect(res429.wafKind).toBe('RATE_LIMITED');
    });

    it('detects Cloudflare bot challenge titles', () => {
      const html =
        '<html><head><title>Just a moment...</title></head><body></body></html>';
      const res = verifier.detectBlockedStatus(
        'https://biorxiv.org',
        html,
        200,
      );
      expect(res.isBlocked).toBe(true);
      expect(res.wafKind).toBe('BOT_CHALLENGE_TITLE');
      expect(res.promptUploadPdf).toBe(true);
    });

    it('detects WAF body signatures (PerimeterX, Cloudflare challenge-platform)', () => {
      const html =
        '<html><body><div id="cf-challenge-running">Please wait...</div></body></html>';
      const res = verifier.detectBlockedStatus(
        'https://example.com',
        html,
        200,
      );
      expect(res.isBlocked).toBe(true);
      expect(res.wafKind).toBe('WAF_INTERSTITIAL_BODY');
    });

    it('returns isBlocked = false for normal academic HTML', () => {
      const html =
        '<html><head><title>Attention Is All You Need</title></head><body>Normal content</body></html>';
      const res = verifier.detectBlockedStatus(
        'https://arxiv.org/abs/1706.03762',
        html,
        200,
      );
      expect(res.isBlocked).toBe(false);
      expect(res.promptUploadPdf).toBe(false);
    });
  });
});
