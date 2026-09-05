import { CatalogItemMapper } from '@/modules/library/items/items.mapper';

describe('CatalogItemMapper Unit Tests (Primary Attachment & URL Normalization)', () => {
  it('selects primary_pdf attachment when attachmentType is primary_pdf even if it is at index 1', () => {
    const rawItem = {
      id: 'item-1',
      workspaceId: 'ws-1',
      title: 'Deep Learning',
      fileUrl: null,
      attachments: [
        {
          id: 'att-csv',
          fileId: 'file-csv',
          filename: 'dataset.csv',
          mimeType: 'text/csv',
          attachmentType: 'supplementary_data',
          url: '/api/files/file-csv',
          revisions: [{ id: 'rev-1', url: '/api/files/file-csv' }],
        },
        {
          id: 'att-pdf',
          fileId: 'file-pdf-primary',
          filename: 'paper.pdf',
          mimeType: 'application/pdf',
          attachmentType: 'primary_pdf',
          url: '/api/files/file-pdf-primary',
          revisions: [{ id: 'rev-2', url: '/api/files/file-pdf-primary' }],
        },
      ],
    };

    const mapped = CatalogItemMapper.toDomain(rawItem);
    expect(mapped.fileUrl).toBe('/api/files/file-pdf-primary/content');
    expect(mapped.attachments[0].url).toBe('/api/files/file-csv/content');
    expect(mapped.attachments[1].url).toBe(
      '/api/files/file-pdf-primary/content',
    );
    expect(mapped.attachments[1].revisions[0].url).toBe(
      '/api/files/file-pdf-primary/content',
    );
  });

  it('does NOT default to attachments[0] if attachments[0] is not a PDF and no PDF attachment exists', () => {
    const rawItem = {
      id: 'item-2',
      workspaceId: 'ws-1',
      title: 'Dataset Reference',
      fileUrl: null,
      attachments: [
        {
          id: 'att-zip',
          fileId: 'file-zip',
          filename: 'archive.zip',
          mimeType: 'application/zip',
          attachmentType: 'supplementary_archive',
          url: '/api/files/file-zip',
        },
      ],
    };

    const mapped = CatalogItemMapper.toDomain(rawItem);
    expect(mapped.fileUrl).toBeNull();
    expect(mapped.attachments[0].url).toBe('/api/files/file-zip/content');
  });

  it('replaces legacy metadata URL (/api/files/:fileId) with canonical content URL (/api/files/:fileId/content)', () => {
    const rawItem = {
      id: 'item-3',
      workspaceId: 'ws-1',
      title: 'Legacy Paper',
      fileUrl: '/api/files/legacy-file-id',
      attachments: [
        {
          id: 'att-1',
          fileId: 'legacy-file-id',
          filename: 'doc.pdf',
          mimeType: 'application/pdf',
          attachmentType: 'attachment',
          url: '/api/files/legacy-file-id',
        },
      ],
    };

    const mapped = CatalogItemMapper.toDomain(rawItem);
    expect(mapped.fileUrl).toBe('/api/files/legacy-file-id/content');
    expect(mapped.attachments[0].url).toBe('/api/files/legacy-file-id/content');
  });

  it('normalizes deduplicated item responses cleanly', () => {
    const rawDedupItem = {
      id: 'item-dedup',
      workspaceId: 'ws-1',
      title: 'Existing Deduped Paper',
      fileUrl: '',
      attachments: [
        {
          id: 'att-dedup',
          fileId: 'file-dedup-1',
          filename: 'existing.pdf',
          mimeType: 'application/pdf',
          url: '/api/files/file-dedup-1',
        },
      ],
    };

    const mapped = CatalogItemMapper.toDomain(rawDedupItem);
    expect(mapped.fileUrl).toBe('/api/files/file-dedup-1/content');
  });

  it('projects all persisted identifiers and keeps editors out of the author list', () => {
    const mapped = CatalogItemMapper.toDomain({
      id: 'item-identifiers',
      title: 'Metadata record',
      fileUrl: null,
      attachments: [],
      doi: '10.1000/example',
      arxivId: '2401.12345',
      pmid: '12345678',
      pmcid: 'PMC1234567',
      isbn: '978-1-4028-9462-6',
      issn: '1234-5678',
      contributors: [
        { creatorType: 'author', fullName: 'Ada Lovelace' },
        { creatorType: 'editor', fullName: 'Grace Hopper' },
      ],
      identifiers: [],
    });

    expect((mapped as any).authors).toEqual(['Ada Lovelace']);
    expect((mapped as any).identifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'doi', value: '10.1000/example' }),
        expect.objectContaining({ type: 'arxiv', value: '2401.12345' }),
        expect.objectContaining({ type: 'pmid', value: '12345678' }),
        expect.objectContaining({ type: 'pmcid', value: 'PMC1234567' }),
        expect.objectContaining({ type: 'isbn', value: '978-1-4028-9462-6' }),
        expect.objectContaining({ type: 'issn', value: '1234-5678' }),
      ]),
    );
  });
});
