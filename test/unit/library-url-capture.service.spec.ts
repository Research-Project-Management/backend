import { UrlCaptureService } from '../../src/modules/library/processing/application/services/url-capture.service';

jest.mock(
  '../../src/modules/library/content/application/services/web-snapshot.service',
  () => ({ WebSnapshotService: class WebSnapshotService {} }),
);

describe('UrlCaptureService', () => {
  it('binds personal capture tokens to the current user scope', async () => {
    const prisma = {
      capturePreview: { create: jest.fn().mockResolvedValue({}) },
    } as any;
    const provider = {
      captureFromUrl: jest.fn().mockResolvedValue({
        title: 'Captured article',
        url: 'https://example.org/article',
        itemType: 'journalArticle',
        previewToken: 'signed-token',
      }),
      calculateMetadataDigest: jest.fn().mockReturnValue('digest'),
    } as any;
    const service = new UrlCaptureService(prisma, provider);

    await service.captureUrl('https://example.org/article', {
      userId: 'user-1',
    });

    expect(provider.captureFromUrl).toHaveBeenCalledWith(
      'https://example.org/article',
      { scopeId: 'user-1', userId: 'user-1' },
    );
  });

  it('creates confirmed URL items in the requested project library', async () => {
    const preview = {
      id: 'preview-1',
      sourceUrl: 'https://example.org/article',
      userId: 'user-1',
      canonicalMetadata: {
        title: 'Captured article',
        url: 'https://example.org/article',
        itemType: 'journalArticle',
      },
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const prisma = {
      capturePreview: {
        findUnique: jest.fn().mockResolvedValue(preview),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    } as any;
    const provider = {
      verifyPreviewToken: jest.fn().mockReturnValue({ valid: true }),
    } as any;
    const items = {
      createItem: jest.fn().mockResolvedValue({
        id: 'item-1',
        title: 'Captured article',
      }),
    } as any;
    const service = new UrlCaptureService(prisma, provider, undefined, items);

    await service.confirmCapturedUrl('project-1', 'user-1', {
      previewToken: 'signed-token',
    });

    expect(provider.verifyPreviewToken).toHaveBeenCalledWith(
      preview.canonicalMetadata,
      'signed-token',
      { scopeId: 'project-1', userId: 'user-1' },
    );
    expect(items.createItem).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ title: 'Captured article' }),
      { source: 'url', projectId: 'project-1' },
      'project-1',
    );
  });
});
