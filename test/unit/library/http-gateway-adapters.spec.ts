import { HttpCatalogGatewayAdapter as ExtractionCatalogGateway } from '@/modules/library/extraction/core/adapters/http-catalog-gateway.adapter';
import { HttpCatalogGatewayAdapter as CitationCatalogGateway } from '@/modules/library/citation/core/adapters/http-catalog-gateway.adapter';
import { HttpCatalogGatewayAdapter as IngestionCatalogGateway } from '@/modules/library/ingestion/core/adapters/http-catalog-gateway.adapter';
import { HttpExtractionGatewayAdapter as IngestionExtractionGateway } from '@/modules/library/ingestion/core/adapters/http-extraction-gateway.adapter';
import { ResilienceRegistryService } from '@/modules/library/shared-kernel/resilience/resilience-registry.service';

describe('Phase 0: Remote HTTP Gateway Adapters', () => {
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.LIBRARY_CATALOG_URL;
    delete process.env.LIBRARY_EXTRACTION_URL;
  });

  describe('Extraction -> Catalog Gateway Adapter', () => {
    it('should verify item existence when catalog returns 200', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: { id: 'item-123', title: 'Quantum Computing' },
        }),
      });

      const adapter = new ExtractionCatalogGateway(undefined, undefined);
      const exists = await adapter.itemExists('user-1', 'item-123');

      expect(exists).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/library/items/item-123'),
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should return false for itemExists when catalog returns 404', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      });

      const adapter = new ExtractionCatalogGateway(undefined, undefined);
      const exists = await adapter.itemExists('user-1', 'non-existent-item');

      expect(exists).toBe(false);
    });

    it('should append project scope when projectId is provided', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ id: 'item-123' }),
      });

      const adapter = new ExtractionCatalogGateway(undefined, undefined);
      await adapter.getItem('user-1', 'item-123', 'proj-999');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(
          '/api/v1/projects/proj-999/library/items/item-123',
        ),
        expect.any(Object),
      );
    });

    it('should trip circuit breaker on consecutive remote failures', async () => {
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('Connection refused'));

      const resilience = new ResilienceRegistryService();
      const adapter = new ExtractionCatalogGateway(undefined, resilience);

      // Trigger 5 failures
      for (let i = 0; i < 5; i++) {
        const res = await adapter.getItem('user-1', 'item-123');
        expect(res).toBeNull();
      }

      const breaker = resilience.getCircuitBreaker('catalog-microservice');
      expect(breaker.getState()).toBe('OPEN');

      // 6th call should fast-fail via circuit breaker fallback without calling fetch
      const callsBefore = (global.fetch as jest.Mock).mock.calls.length;
      const resFastFail = await adapter.getItem('user-1', 'item-123');
      expect(resFastFail).toBeNull();
      expect((global.fetch as jest.Mock).mock.calls.length).toBe(callsBefore);
    });
  });

  describe('Citation -> Catalog Gateway Adapter', () => {
    it('should batch-fetch items by IDs', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: 'item-1', title: 'Paper 1' },
            { id: 'item-2', title: 'Paper 2' },
          ],
        }),
      });

      const adapter = new CitationCatalogGateway(undefined, undefined);
      const items = await adapter.findByIds('user-1', ['item-1', 'item-2']);

      expect(items).toHaveLength(2);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/library/items/batch'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ ids: ['item-1', 'item-2'] }),
        }),
      );
    });

    it('should fallback to concurrent individual queries if batch endpoint fails', async () => {
      global.fetch = jest
        .fn()
        // Batch endpoint fails with 500
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        })
        // Individual item 1 succeeds
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'item-1', title: 'Paper 1' }),
        })
        // Individual item 2 succeeds
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({ id: 'item-2', title: 'Paper 2' }),
        });

      const adapter = new CitationCatalogGateway(undefined, undefined);
      const items = await adapter.findByIds('user-1', ['item-1', 'item-2']);

      expect(items).toHaveLength(2);
      expect(items[0].id).toBe('item-1');
      expect(items[1].id).toBe('item-2');
    });
  });

  describe('Ingestion -> Catalog & Extraction Gateway Adapters', () => {
    it('should post createItem to remote catalog microservice', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          data: { id: 'new-item-1', title: 'Deep Learning' },
        }),
      });

      const adapter = new IngestionCatalogGateway(undefined, undefined);
      const created = await adapter.createItem('user-1', {
        title: 'Deep Learning',
      });

      expect(created.id).toBe('new-item-1');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/library/items'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ title: 'Deep Learning' }),
        }),
      );
    });

    it('should dispatch web snapshot request to extraction service', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { snapshotId: 'snap-1', status: 'READY' } }),
      });

      const adapter = new IngestionExtractionGateway(undefined, undefined);
      const res = await adapter.captureWebSnapshot(
        'https://arxiv.org/abs/2301.00001',
        'item-1',
        'user-1',
      );

      expect(res.snapshotId).toBe('snap-1');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/v1/library/attachments/snapshot'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            url: 'https://arxiv.org/abs/2301.00001',
            itemId: 'item-1',
          }),
        }),
      );
    });
  });
});
