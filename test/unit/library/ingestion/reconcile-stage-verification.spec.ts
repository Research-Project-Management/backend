import { ReconcileStage } from '@/modules/library/ingestion/stages/reconcile.stage';
import { ReconciliationPolicy } from '@/modules/library/ingestion/policies/reconciliation.policy';
import { IngestionVerifierService } from '@/modules/library/ingestion/services/ingestion-verifier.service';
import { MetadataCandidate } from '@/modules/library/ingestion/types/metadata-candidate.types';

describe('ReconcileStage with IngestionVerifierService', () => {
  let stage: ReconcileStage;
  let policy: ReconciliationPolicy;
  let verifier: IngestionVerifierService;

  beforeEach(() => {
    policy = new ReconciliationPolicy();
    verifier = new IngestionVerifierService();
    stage = new ReconcileStage(policy, verifier);
  });

  it('performs cross-verification scoring for PDF + external provider candidate', async () => {
    const fileCandidate: MetadataCandidate = {
      candidateId: 'pdf-cand-1',
      sourceKind: 'FILE',
      sourceName: 'TrustedPaper',
      retrievedAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      fields: {},
      normalizedMetadata: {
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani', 'Noam Shazeer'],
        year: 2017,
        arxivId: '1706.03762v7',
        doi: '10.48550/arXiv.1706.03762',
      },
      confidenceScore: 0.95,
    };

    const webCandidate: MetadataCandidate = {
      candidateId: 'web-cand-1',
      sourceKind: 'PROVIDER',
      sourceName: 'EnrichedProvider',
      retrievedAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      fields: {},
      normalizedMetadata: {
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani', 'Noam Shazeer'],
        year: 2017,
        arxivId: '1706.03762v7',
        doi: '10.48550/arXiv.1706.03762',
        journal: 'arXiv',
        abstract:
          'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks.',
      },
      confidenceScore: 0.95,
    };

    const decision = await stage.execute([fileCandidate, webCandidate]);

    expect(decision).toBeDefined();
    expect(decision.proposedItem.title).toBe('Attention Is All You Need');
    expect(decision.proposedItem.extraFields).toBeDefined();

    const extra = decision.proposedItem.extraFields!;
    expect(extra.ingestionStatus).toBe('COMPLETE');
    expect(extra.isVerified).toBe(true);
    expect(typeof extra.verificationScore).toBe('number');
    expect((extra.verificationScore as number) >= 0.8).toBe(true);

    const provenance = extra.fieldProvenance as Record<string, any>;
    expect(provenance).toBeDefined();
    expect(provenance.title?.verified).toBe(true);
    expect(provenance.authors?.verified).toBe(true);
    expect(provenance.arxivId?.verified).toBe(true);
  });

  it('evaluates standalone local PDF extraction without external web lookups', async () => {
    const fileCandidate: MetadataCandidate = {
      candidateId: 'pdf-cand-standalone',
      sourceKind: 'FILE',
      sourceName: 'TrustedPaper',
      retrievedAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      fields: {},
      normalizedMetadata: {
        title: 'Deep Residual Learning for Image Recognition',
        authors: ['Kaiming He', 'Xiangyu Zhang', 'Shaoqing Ren', 'Jian Sun'],
        year: 2015,
        arxivId: '1512.03385v1',
        qualityScore: 0.92,
        engineUsed: 'LOCAL_IN_PROCESS',
      },
      confidenceScore: 0.92,
    };

    const decision = await stage.execute([fileCandidate]);

    expect(decision.proposedItem.title).toBe(
      'Deep Residual Learning for Image Recognition',
    );
    const extra = decision.proposedItem.extraFields!;
    expect(extra.ingestionStatus).toBe('PARTIAL'); // Partial because abstract/journal is missing locally
    expect(extra.isVerified).toBe(true);
    expect(extra.verificationScore).toBe(0.92);
  });

  it('marks BLOCKED status when candidate is flagged by WAF interstitial', async () => {
    const blockedUrlCandidate: MetadataCandidate = {
      candidateId: 'url-blocked-1',
      sourceKind: 'URL',
      sourceName: 'UrlCapture',
      retrievedAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      fields: {},
      normalizedMetadata: {
        title: 'Document',
        url: 'https://www.biorxiv.org/content/10.1101/2020.03.22.002386v1',
        doi: '10.1101/2020.03.22.002386',
        extraFields: {
          isBlocked: true,
          wafKind: 'CLOUDFLARE_TURNSTILE',
          promptUploadPdf: true,
        },
      },
      confidenceScore: 0.3,
    };

    const decision = await stage.execute([blockedUrlCandidate]);

    const extra = decision.proposedItem.extraFields!;
    expect(extra.ingestionStatus).toBe('BLOCKED');
    expect(extra.promptUploadPdf).toBe(true);
    expect(extra.wafKind).toBe('CLOUDFLARE_TURNSTILE');
    expect(extra.isVerified).toBe(false);
  });

  it('discards external candidate and revokes cited DOI when Page-1 citation trap is detected', async () => {
    // Local authentic PDF extraction
    const fileCandidate: MetadataCandidate = {
      candidateId: 'pdf-my-paper',
      sourceKind: 'FILE',
      sourceName: 'TrustedPaper',
      retrievedAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      fields: {},
      normalizedMetadata: {
        title: 'Deep Transfer Learning for Vietnamese Rice Disease Detection',
        authors: ['Nguyễn Văn An', 'Trần Thị Mai'],
        year: 2023,
        doi: '10.48550/arXiv.1706.03762', // Accidental cited DOI from page 1 footnote
      },
      confidenceScore: 0.9,
    };

    // External provider candidate resolved from the cited DOI (e.g. CrossRef)
    const externalCitedCandidate: MetadataCandidate = {
      candidateId: 'crossref-cited-paper',
      sourceKind: 'PROVIDER',
      sourceName: 'EnrichedProvider',
      retrievedAt: new Date().toISOString(),
      schemaVersion: '1.0.0',
      fields: {},
      normalizedMetadata: {
        title: 'Attention Is All You Need',
        authors: ['Ashish Vaswani', 'Noam Shazeer'],
        year: 2017,
        doi: '10.48550/arXiv.1706.03762',
        journal: 'NeurIPS',
      },
      confidenceScore: 0.95,
    };

    const decision = await stage.execute([
      fileCandidate,
      externalCitedCandidate,
    ]);

    // Must NOT adopt the cited paper's title or authors!
    expect(decision.proposedItem.title).toBe(
      'Deep Transfer Learning for Vietnamese Rice Disease Detection',
    );
    expect(decision.proposedItem.authors).toEqual([
      'Nguyễn Văn An',
      'Trần Thị Mai',
    ]);
    // The cited DOI must be revoked from the main item
    expect(decision.proposedItem.doi).toBeUndefined();

    // Warnings and extraFields must record the disambiguation action
    const extra = decision.proposedItem.extraFields!;
    expect(extra.disambiguationWarning).toContain(
      'Page-1 cited paper DOI mismatch discarded',
    );
    expect(extra.rejectedCitedDoi).toBe('10.48550/arXiv.1706.03762');
  });
});
