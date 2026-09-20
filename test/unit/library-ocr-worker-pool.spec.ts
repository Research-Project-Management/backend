import { OcrWorkerPoolService } from '../../src/modules/library/content/infrastructure/ocr/ocr-worker-pool.service';

describe('OcrWorkerPoolService', () => {
  let service: OcrWorkerPoolService;

  beforeEach(() => {
    service = new OcrWorkerPoolService();
  });

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('respects concurrency and language defaults', () => {
    expect(service.concurrency).toBeGreaterThanOrEqual(1);
    expect(service.concurrency).toBeLessThanOrEqual(4);
    expect(service.defaultLanguages).toContain('vie');
    expect(service.defaultLanguages).toContain('eng');
    expect(service.defaultLangPath).toBeDefined();
  });

  it('handles per-job timeout rejection gracefully', async () => {
    // Mock the internal scheduler to simulate a stalled job
    const mockScheduler: any = {
      addJob: jest
        .fn()
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(resolve, 500)),
        ),
      terminate: jest.fn().mockResolvedValue(undefined),
    };

    (service as any).scheduler = mockScheduler;
    (service as any).workers = [{}];

    // Trigger recognize with a tiny timeout of 50ms
    await expect(
      service.recognize(Buffer.from('fake-image'), 50),
    ).rejects.toThrow(/timed out after/);
  });
});
