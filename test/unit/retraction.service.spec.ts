import { RetractionService } from '../../src/modules/library/retraction/retraction.service';
import { RetractionRepository } from '../../src/modules/library/retraction/retraction.repository';
import { RetractionScannerProvider } from '../../src/modules/library/retraction/providers/retraction-scanner.provider';

describe('RetractionService', () => {
  let service: RetractionService;
  let mockRepo: any;
  let mockScanner: any;

  const workspaceId = '00000000-0000-0000-0000-000000000001';
  const itemId = 'item-123';

  beforeEach(() => {
    mockRepo = {
      findItemById: jest.fn(),
      findItemsForScan: jest.fn(),
      updateItemRetraction: jest.fn(),
      findRetractedItems: jest.fn(),
      getWorkspaceStats: jest.fn(),
    };

    mockScanner = {
      scan: jest.fn(),
    };

    service = new RetractionService(mockRepo, mockScanner);
  });

  it('marks item as retracted when scanner detects retraction', async () => {
    mockRepo.findItemById.mockResolvedValue({
      id: itemId,
      doi: '10.1016/s0140-6736(20)31180-6',
      title: 'Hydroxychloroquine Lancet study',
      isRetracted: false,
    });

    mockScanner.scan.mockResolvedValue({
      nature: 'retraction',
      reason: 'Authors retracted study due to data audit concerns',
      noticeUrl: 'https://doi.org/10.1016/s0140-6736(20)31324-6',
      source: 'crossref',
    });

    const result = await service.checkItem(workspaceId, itemId);

    expect(result.isRetracted).toBe(true);
    expect(result.nature).toBe('retraction');
    expect(result.details?.reason).toContain('Authors retracted study');
    expect(mockRepo.updateItemRetraction).toHaveBeenCalledWith(
      itemId,
      true,
      'retraction',
      expect.any(Object),
      expect.any(Date),
    );
  });

  it('marks item as not retracted when scanner finds no issues', async () => {
    mockRepo.findItemById.mockResolvedValue({
      id: itemId,
      doi: '10.1038/nature14539',
      title: 'Deep Learning',
      isRetracted: false,
    });

    mockScanner.scan.mockResolvedValue(null);

    const result = await service.checkItem(workspaceId, itemId);

    expect(result.isRetracted).toBe(false);
    expect(mockRepo.updateItemRetraction).toHaveBeenCalledWith(
      itemId,
      false,
      null,
      null,
      expect.any(Date),
    );
  });

  it('allows researcher to set manual retraction flag', async () => {
    mockRepo.findItemById.mockResolvedValue({
      id: itemId,
      doi: '10.1101/preprint-123',
      title: 'Preprint with flawed statistics',
      isRetracted: false,
    });

    await service.setManualFlag(workspaceId, itemId, {
      nature: 'manual',
      reason: 'Flagged by lab PI: code irreproducible',
    });

    expect(mockRepo.updateItemRetraction).toHaveBeenCalledWith(
      itemId,
      true,
      'manual',
      expect.objectContaining({
        reason: 'Flagged by lab PI: code irreproducible',
        source: 'manual',
      }),
      expect.any(Date),
    );
  });

  it('preserves manual retraction flag during automated scans', async () => {
    mockRepo.findItemById.mockResolvedValue({
      id: itemId,
      isRetracted: true,
      retractionNature: 'manual',
      retractionDetails: { reason: 'Manually flagged by user' },
    });

    const result = await service.checkItem(workspaceId, itemId);

    expect(result.isRetracted).toBe(true);
    expect(result.nature).toBe('manual');
    expect(mockScanner.scan).not.toHaveBeenCalled();
  });

  it('removes manual retraction flag when unflagged', async () => {
    mockRepo.findItemById.mockResolvedValue({
      id: itemId,
      isRetracted: true,
      retractionNature: 'manual',
    });

    await service.removeManualFlag(workspaceId, itemId);

    expect(mockRepo.updateItemRetraction).toHaveBeenCalledWith(
      itemId,
      false,
      null,
      null,
      expect.any(Date),
    );
  });
});
