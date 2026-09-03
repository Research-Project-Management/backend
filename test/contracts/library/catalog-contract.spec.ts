import {
  CATALOG_READ_PORT,
  ICatalogReadPort,
  CatalogItemDetail,
  CATALOG_COMMIT_PORT,
  ICatalogCommitPort,
  ITEM_EXISTENCE_PORT,
  IItemExistencePort,
} from '../../../src/modules/library/catalog/ports/catalog.ports';
import {
  CatalogItemSummary,
  ItemMetadata,
  CreatorCredit,
  ItemIdentifier,
} from '../../../src/modules/library/catalog/types/catalog.types';

describe('Library Catalog Contracts & Port Conventions (T012)', () => {
  describe('Port DI Tokens', () => {
    it('should export unique runtime Symbol DI tokens for ports', () => {
      expect(typeof CATALOG_READ_PORT).toBe('symbol');
      expect(typeof CATALOG_COMMIT_PORT).toBe('symbol');
      expect(typeof ITEM_EXISTENCE_PORT).toBe('symbol');

      expect(CATALOG_READ_PORT.toString()).toBe('Symbol(CATALOG_READ_PORT)');
      expect(CATALOG_COMMIT_PORT.toString()).toBe(
        'Symbol(CATALOG_COMMIT_PORT)',
      );
      expect(ITEM_EXISTENCE_PORT.toString()).toBe(
        'Symbol(ITEM_EXISTENCE_PORT)',
      );
    });
  });

  describe('Item Summary Contract Fixtures', () => {
    it('should conform to minimal summary interface without internal ORM leaks', () => {
      const summaryFixture: CatalogItemSummary = {
        id: '11111111-1111-4111-a111-111111111111',
        workspaceId: '22222222-2222-4222-a222-222222222222',
        title: 'Attention Is All You Need',
        itemType: 'journalArticle',
        year: 2017,
        doi: '10.48550/arXiv.1706.03762',
        primaryAuthors: ['Ashish Vaswani', 'Noam Shazeer'],
        createdAt: new Date('2026-08-01T00:00:00Z'),
        updatedAt: new Date('2026-08-02T00:00:00Z'),
      };

      expect(summaryFixture.id).toBeDefined();
      expect(summaryFixture.workspaceId).toBeDefined();
      expect(summaryFixture.title).toBe('Attention Is All You Need');
      expect(Array.isArray(summaryFixture.primaryAuthors)).toBe(true);
      expect(summaryFixture.primaryAuthors).toHaveLength(2);
    });
  });

  describe('Creator and Identifier Structured Types', () => {
    it('should represent structured ordered creators with valid types', () => {
      const authorCredit: CreatorCredit = {
        id: '33333333-3333-4333-a333-333333333333',
        orderIndex: 0,
        creatorType: 'author',
        firstName: 'Ashish',
        lastName: 'Vaswani',
        fullName: 'Ashish Vaswani',
      };

      expect(authorCredit.creatorType).toBe('author');
      expect(authorCredit.orderIndex).toBe(0);
      expect(authorCredit.fullName).toBe('Ashish Vaswani');
    });

    it('should represent structured identifiers with supported schemes', () => {
      const doiIdentifier: ItemIdentifier = {
        id: '44444444-4444-4444-a444-444444444444',
        type: 'doi',
        value: '10.48550/arXiv.1706.03762',
        canonicalUri: 'https://doi.org/10.48550/arXiv.1706.03762',
      };

      expect(doiIdentifier.type).toBe('doi');
      expect(doiIdentifier.value).toBe('10.48550/arXiv.1706.03762');
    });
  });

  describe('Item Metadata Domain Contract', () => {
    it('should hold complete domain bibliographic attributes', () => {
      const itemMetadata: ItemMetadata = {
        title: 'Deep Residual Learning for Image Recognition',
        itemType: 'conferencePaper',
        year: 2016,
        publicationTitle:
          'Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition',
        abstract: 'Deeper neural networks are more difficult to train...',
        creators: [
          {
            orderIndex: 0,
            creatorType: 'author',
            fullName: 'Kaiming He',
          },
        ],
        identifiers: [
          {
            type: 'doi',
            value: '10.1109/CVPR.2016.90',
          },
        ],
      };

      expect(itemMetadata.title).toBe(
        'Deep Residual Learning for Image Recognition',
      );
      expect(itemMetadata.creators).toHaveLength(1);
      expect(itemMetadata.identifiers).toHaveLength(1);
    });
  });
});
