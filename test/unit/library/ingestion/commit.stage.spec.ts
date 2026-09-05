import { toCatalogItemData } from '@/modules/library/ingestion/stages/commit.stage';
import { ItemMetadata } from '@/modules/library/ingestion/metadata/types/metadata.types';

describe('toCatalogItemData', () => {
  it('preserves canonical metadata and provider enrichment at the commit boundary', () => {
    const metadata: ItemMetadata = {
      title: 'Complete metadata record',
      itemType: 'journalArticle',
      type: 'Research Article',
      doi: '10.1000/example',
      arxivId: '2401.12345',
      pmid: '12345678',
      pmcid: 'PMC1234567',
      issn: '1234-5678',
      isbn: '978-1-4028-9462-6',
      year: 2026,
      publicationDate: '2026-09-04',
      publicationTitle: 'Journal of Complete Records',
      journalAbbr: 'J Complete Rec',
      publisher: 'Flux Press',
      place: 'Bangkok',
      volume: '12',
      issue: '3',
      section: 'Research',
      partNumber: 'II',
      partTitle: 'Methods',
      pages: '100-120',
      series: 'Research Series',
      seriesTitle: 'Applied Science',
      seriesText: 'No. 8',
      seriesNumber: '8',
      shortTitle: 'Complete record',
      abstract: 'Canonical abstract',
      abstractNote: 'Imported abstract note',
      tldr: 'A concise finding',
      citationCount: 17,
      referenceCount: 42,
      influentialCitationCount: 4,
      url: 'https://example.test/article',
      pdfUrl: 'https://example.test/article.pdf',
      openAccessPdfUrl: 'https://example.test/open.pdf',
      language: 'en',
      rights: 'CC BY 4.0',
      license: 'CC-BY-4.0',
      archive: 'Internet Archive',
      archiveLocation: 'ia:complete-record',
      callNumber: 'QA 100',
      libraryCatalog: 'Flux catalog',
      accessedAt: '2026-09-04T10:00:00.000Z',
      extra: 'Keep this provider note intact',
      extraFields: { conferenceName: 'FluxConf' },
      notes: [{ content: 'Imported note', source: 'BibTeX' }],
      authors: ['Ada Lovelace'],
      editors: ['Grace Hopper'],
      tags: ['metadata'],
    };

    const data = toCatalogItemData(metadata, {
      collectionIds: ['collection-1'],
      userId: 'user-1',
    });

    expect(data).toMatchObject({
      title: metadata.title,
      doi: metadata.doi,
      arxivId: metadata.arxivId,
      pmid: metadata.pmid,
      pmcid: metadata.pmcid,
      issn: metadata.issn,
      isbn: metadata.isbn,
      publicationDate: metadata.publicationDate,
      publicationTitle: metadata.publicationTitle,
      journalAbbr: metadata.journalAbbr,
      place: metadata.place,
      section: metadata.section,
      partNumber: metadata.partNumber,
      partTitle: metadata.partTitle,
      seriesText: metadata.seriesText,
      seriesNumber: metadata.seriesNumber,
      archiveLocation: metadata.archiveLocation,
      libraryCatalog: metadata.libraryCatalog,
      extra: metadata.extra,
      collectionId: 'collection-1',
      uploadedById: 'user-1',
    });
    expect(data.accessedAt).toEqual(new Date('2026-09-04T10:00:00.000Z'));
    expect(data.fileUrl).toBe(metadata.pdfUrl);
    expect(data.extraFields).toEqual({
      conferenceName: 'FluxConf',
      abstractNote: metadata.abstractNote,
      tldr: metadata.tldr,
      citationCount: metadata.citationCount,
      referenceCount: metadata.referenceCount,
      influentialCitationCount: metadata.influentialCitationCount,
      openAccessPdfUrl: metadata.openAccessPdfUrl,
    });
    expect(data.notes).toEqual(metadata.notes);
    expect(data.creators).toEqual([
      { name: 'Ada Lovelace', creatorType: 'author' },
      { name: 'Grace Hopper', creatorType: 'editor' },
    ]);
    expect(data.contributors).toBeUndefined();
  });

  it('does not persist an invalid access date', () => {
    const data = toCatalogItemData({
      title: 'Invalid access date',
      accessedAt: 'not-a-date',
    });

    expect(data.accessedAt).toBeUndefined();
  });
});
