import { IdentifyStage } from '@/modules/library/ingestion/stages/identify.stage';
import { DoiParser } from '@/modules/library/ingestion/parsers/doi.parser';
import { BibtexParser } from '@/modules/library/ingestion/parsers/bibtex.parser';
import { RisParser } from '@/modules/library/ingestion/parsers/ris.parser';
import { NormalizationPolicy } from '@/modules/library/ingestion/policies/normalization.policy';

describe('IdentifyStage FILE metadata', () => {
  it('preserves extracted bibliographic fields through normalization', async () => {
    const storagePort = {
      readOwnedFile: jest.fn().mockResolvedValue({
        buffer: Buffer.from('%PDF-1.7'),
      }),
    };
    const pdfExtractor = {
      extractDocumentFromBuffer: jest.fn().mockResolvedValue({
        metadata: {
          title: 'A Reliable Paper Title',
          authors: ['Ada Lovelace'],
          year: 2024,
          journal: 'Journal of Reliable Systems',
          abstract: 'A concise abstract for a reliable paper.',
          keywords: ['metadata', 'ingestion'],
          rawText: 'PDF body must not become catalog metadata',
        },
      }),
    };
    const stage = new IdentifyStage(
      new DoiParser(),
      new BibtexParser(),
      new RisParser(),
      new NormalizationPolicy(),
      storagePort,
      pdfExtractor as any,
    );

    const [candidate] = await stage.execute(
      'run-1',
      { kind: 'FILE', fileId: 'file-1', filename: 'fallback.pdf' },
      'workspace-1',
    );

    expect(candidate.normalizedMetadata).toMatchObject({
      title: 'A Reliable Paper Title',
      authors: ['Ada Lovelace'],
      year: 2024,
      journal: 'Journal of Reliable Systems',
      publicationTitle: 'Journal of Reliable Systems',
      abstract: 'A concise abstract for a reliable paper.',
      fileId: 'file-1',
      filename: 'fallback.pdf',
    });
    expect(candidate.normalizedMetadata.tags).toEqual([
      'metadata',
      'ingestion',
    ]);
    expect((candidate.normalizedMetadata as any).rawText).toBeUndefined();
  });

  it('keeps the upload usable when full PDF parsing fails', async () => {
    const storagePort = {
      readOwnedFile: jest.fn().mockResolvedValue({
        buffer: Buffer.from('%PDF-1.7'),
      }),
    };
    const pdfExtractor = {
      extractDocumentFromBuffer: jest
        .fn()
        .mockRejectedValue(new Error('encrypted PDF')),
      extractMetadataFromBuffer: jest.fn().mockReturnValue({
        doi: '10.1000/fallback',
      }),
    };
    const stage = new IdentifyStage(
      new DoiParser(),
      new BibtexParser(),
      new RisParser(),
      new NormalizationPolicy(),
      storagePort,
      pdfExtractor as any,
    );

    const [candidate] = await stage.execute(
      'run-2',
      { kind: 'FILE', fileId: 'file-2', filename: 'fallback-paper.pdf' },
      'workspace-1',
    );

    expect(candidate.normalizedMetadata).toMatchObject({
      title: 'fallback-paper.pdf',
      doi: '10.1000/fallback',
      fileId: 'file-2',
    });
  });

  it('resolves arXiv identifiers from filenames when the PDF has no metadata', async () => {
    const storagePort = {
      readOwnedFile: jest.fn().mockResolvedValue({
        buffer: Buffer.from('%PDF-1.7'),
      }),
    };
    const pdfExtractor = {
      extractDocumentFromBuffer: jest.fn().mockResolvedValue({ metadata: {} }),
    };
    const stage = new IdentifyStage(
      new DoiParser(),
      new BibtexParser(),
      new RisParser(),
      new NormalizationPolicy(),
      storagePort,
      pdfExtractor as any,
    );

    const [candidate] = await stage.execute(
      'run-3',
      { kind: 'FILE', fileId: 'file-3', filename: '1512.03385v1.pdf' },
      'workspace-1',
    );

    expect(candidate.normalizedMetadata).toMatchObject({
      arxivId: '1512.03385v1',
      title: '1512.03385v1.pdf',
    });
  });
});

