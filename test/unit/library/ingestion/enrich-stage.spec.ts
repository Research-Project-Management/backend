import { EnrichStage } from '@/modules/library/ingestion/stages/enrich.stage';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';
import type { MetadataCandidate } from '@/modules/library/ingestion/types/metadata-candidate.types';

describe('EnrichStage title fallback', () => {
  const candidate = (title: string): MetadataCandidate => ({
    candidateId: 'candidate-1',
    sourceKind: 'FILE',
    sourceName: 'StagedPdf',
    retrievedAt: new Date().toISOString(),
    schemaVersion: '1.0.0',
    fields: {},
    normalizedMetadata: { title },
    confidenceScore: 0.7,
  });

  it('resolves a credible extracted PDF title when no identifier exists', async () => {
    const metadataService = {
      resolve: jest.fn().mockResolvedValue({
        canonicalId: 'doi:10.1000/example',
        resolvedAt: '2026-09-04T00:00:00.000Z',
        metadata: { title: 'A Reliable Paper Title', doi: '10.1000/example' },
        provenance: {},
      }),
    };
    const stage = new EnrichStage(metadataService as any, new NormalizationPolicy());

    const result = await stage.execute('workspace-1', [candidate('A Reliable Paper Title')]);

    expect(metadataService.resolve).toHaveBeenCalledWith({
      query: 'A Reliable Paper Title',
      workspaceId: 'workspace-1',
    });
    expect(result).toHaveLength(2);
    expect(result[1].normalizedMetadata.doi).toBe('10.1000/example');
  });

  it('does not search a generic or filename fallback', async () => {
    const metadataService = { resolve: jest.fn() };
    const stage = new EnrichStage(metadataService as any, new NormalizationPolicy());

    await stage.execute('workspace-1', [candidate('uploaded document')]);

    expect(metadataService.resolve).not.toHaveBeenCalled();
  });
});
