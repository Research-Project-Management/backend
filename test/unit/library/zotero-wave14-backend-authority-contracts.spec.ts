import { ItemQueryService } from '@/modules/library/catalog/services/item-query.service';
import { QueryRepository } from '@/modules/library/catalog/repositories/query.repository';
import { ItemTransformer } from '@/modules/library/catalog/domain/item.transformer';
import { TypesService } from '@/modules/library/catalog/services/types.service';
import {
  DuplicateService,
  DuplicateDetectorService,
  DuplicateMergerService,
} from '@/modules/library/ingestion/services/duplicate.service';
import { QualityService } from '@/modules/library/ingestion/services/quality.service';
import { Permission, Role } from '@/modules/project/access';

describe('Wave 14 — Backend Authority Contracts (Permissions, Duplicates Hydration, Type Conversion Preview, Facet Counts)', () => {
  const userId = '550e8400-e29b-41d4-a716-446655440001';
  const projectId = '550e8400-e29b-41d4-a716-446655440002';

  describe('Axis 1 & Axis 5 — Authoritative Backend Library Permissions & ItemType Facet Counts (ItemQueryService)', () => {
    it('computes full owner permissions and itemTypes facet counts for Personal Library (!projectId)', async () => {
      const mockQueryRepo = {
        count: jest
          .fn()
          .mockImplementation(async (_u: string, opts: { view?: string }) => opts?.view === 'unfiled' ? 4 : opts?.view === 'starred' ? 3 : opts?.view === 'trash' ? 2 : 15) // all/unfiled/starred/trash
          // unfiled=4, starred=3, trash=2 handled by mockImplementation
          // starred=3 handled by mockImplementation
          , // trash=2 handled by mockImplementation
        countByItemType: jest.fn().mockResolvedValue({
          journalArticle: 10,
          book: 3,
          conferencePaper: 2,
        }),
      } as unknown as QueryRepository;

      const service = new ItemQueryService(mockQueryRepo);
      const result = await service.getCounts(userId);

      expect(result.total).toBe(15);
      expect(result.unfiled).toBe(4);
      expect(result.starred).toBe(3);
      expect(result.trash).toBe(2);
      expect(result.itemTypes).toEqual({
        journalArticle: 10,
        book: 3,
        conferencePaper: 2,
      });
      expect(result.role).toBe('owner');
      expect(result.permissions).toEqual({
        canRead: true,
        canCreateItem: true,
        canEditItem: true,
        canDeleteItem: true,
        canPurgeItem: true,
        canManageCollections: true,
        canImport: true,
        canExport: true,
        canAnnotate: true,
      });
    });

    it('computes authoritative permissions for Project roles (owner, coordinator, contributor, reviewer) and honors permissionOverrides', async () => {
      const mockQueryRepo = {
        count: jest.fn().mockResolvedValue(5),
        countByItemType: jest.fn().mockResolvedValue({ journalArticle: 5 }),
        getProjectMemberRole: jest.fn(),
      } as unknown as QueryRepository;

      const mockAccessService = {
        getMemberAccessContext: jest.fn(),
        hasPermission: jest.fn(),
      };

      const service = new ItemQueryService(
        mockQueryRepo,
        undefined,
        mockAccessService as never,
      );

      // 1. Owner
      mockAccessService.getMemberAccessContext.mockResolvedValueOnce({
        role: Role.OWNER,
        permissionOverrides: {},
        effectivePermissions: Object.values(Permission),
      });
      const ownerPerms = await service.getPermissions(userId, projectId);
      expect(ownerPerms.role).toBe('owner');
      expect(ownerPerms.permissions).toEqual({
        canRead: true,
        canCreateItem: true,
        canEditItem: true,
        canDeleteItem: true,
        canPurgeItem: true,
        canManageCollections: true,
        canImport: true,
        canExport: true,
        canAnnotate: true,
      });

      // 2. Coordinator (canDeleteItem: true for soft-trash, canPurgeItem: false)
      mockAccessService.getMemberAccessContext.mockResolvedValueOnce({
        role: Role.COORDINATOR,
        permissionOverrides: {},
        effectivePermissions: [
          Permission.LIBRARY_VIEW,
          Permission.LIBRARY_READ,
          Permission.LIBRARY_UPLOAD,
          Permission.LIBRARY_UPDATE,
          Permission.LIBRARY_ANNOTATE,
          Permission.LIBRARY_EXPORT,
          Permission.LIBRARY_SYNC,
        ],
      });
      const coordinatorPerms = await service.getPermissions(userId, projectId);
      expect(coordinatorPerms.role).toBe('coordinator');
      expect(coordinatorPerms.permissions).toEqual({
        canRead: true,
        canCreateItem: true,
        canEditItem: true,
        canDeleteItem: true,
        canPurgeItem: false,
        canManageCollections: true,
        canImport: true,
        canExport: true,
        canAnnotate: true,
      });

      // 3. Contributor
      mockAccessService.getMemberAccessContext.mockResolvedValueOnce({
        role: Role.CONTRIBUTOR,
        permissionOverrides: {},
        effectivePermissions: [
          Permission.LIBRARY_VIEW,
          Permission.LIBRARY_READ,
          Permission.LIBRARY_UPLOAD,
          Permission.LIBRARY_UPDATE,
          Permission.LIBRARY_ANNOTATE,
          Permission.LIBRARY_EXPORT,
          Permission.LIBRARY_SYNC,
        ],
      });
      const contributorPerms = await service.getPermissions(userId, projectId);
      expect(contributorPerms.role).toBe('contributor');
      expect(contributorPerms.permissions).toEqual({
        canRead: true,
        canCreateItem: true,
        canEditItem: true,
        canDeleteItem: true,
        canPurgeItem: false,
        canManageCollections: true,
        canImport: true,
        canExport: true,
        canAnnotate: true,
      });

      // 4. Reviewer (read-only + annotate + export)
      mockAccessService.getMemberAccessContext.mockResolvedValueOnce({
        role: Role.REVIEWER,
        permissionOverrides: {},
        effectivePermissions: [
          Permission.LIBRARY_VIEW,
          Permission.LIBRARY_READ,
          Permission.LIBRARY_ANNOTATE,
          Permission.LIBRARY_EXPORT,
        ],
      });
      const reviewerPerms = await service.getPermissions(userId, projectId);
      expect(reviewerPerms.role).toBe('reviewer');
      expect(reviewerPerms.permissions).toEqual({
        canRead: true,
        canCreateItem: false,
        canEditItem: false,
        canDeleteItem: false,
        canPurgeItem: false,
        canManageCollections: false,
        canImport: false,
        canExport: true,
        canAnnotate: true,
      });

      // 5. Coordinator with explicit permissionOverride granting library:delete
      mockAccessService.getMemberAccessContext.mockResolvedValueOnce({
        role: Role.COORDINATOR,
        permissionOverrides: { [Permission.LIBRARY_DELETE]: true },
        effectivePermissions: [
          Permission.LIBRARY_VIEW,
          Permission.LIBRARY_READ,
          Permission.LIBRARY_UPLOAD,
          Permission.LIBRARY_UPDATE,
          Permission.LIBRARY_DELETE,
          Permission.LIBRARY_ANNOTATE,
          Permission.LIBRARY_EXPORT,
        ],
      });
      const overriddenCoordinator = await service.getPermissions(
        userId,
        projectId,
      );
      expect(overriddenCoordinator.permissions.canPurgeItem).toBe(true);
    });
  });

  describe('Axis 3 — Preserve recommendedMasterId & Hydrated Domain Items in DuplicateService', () => {
    it('preserves recommendedMasterId and hydrates full ItemsMapper.toDomain items in detectDuplicates', async () => {
      const itemAId = '550e8400-e29b-41d4-a716-446655440010';
      const itemBId = '550e8400-e29b-41d4-a716-446655440011';

      const mockCatalogGateway = {
        findDuplicateCandidateItems: jest.fn().mockResolvedValue([
          {
            id: itemAId,
            title: 'Attention Is All You Need',
            itemType: 'journalArticle',
            doi: '10.5555/3295222.3295349',
            year: 2017,
            citationKey: 'vaswani2017',
            metadata: {
              publicationTitle:
                'Advances in Neural Information Processing Systems',
              volume: '30',
            },
            contributors: [
              {
                fullName: 'Ashish Vaswani',
                firstName: 'Ashish',
                lastName: 'Vaswani',
                orderIndex: 0,
              },
            ],
          },
          {
            id: itemBId,
            title: 'Attention Is All You Need',
            itemType: 'conferencePaper',
            doi: '10.5555/3295222.3295349',
            year: 2017,
            citationKey: 'vaswani2017b',
            metadata: {
              proceedingsTitle: 'NIPS 2017',
              publisher: 'Curran Associates',
              pages: '5998-6008',
            },
            contributors: [
              {
                fullName: 'Ashish Vaswani',
                firstName: 'Ashish',
                lastName: 'Vaswani',
                orderIndex: 0,
              },
            ],
          },
        ]),
        findByIds: jest.fn().mockResolvedValue([
          {
            id: itemAId,
            title: 'Attention Is All You Need',
            itemType: 'journalArticle',
            doi: '10.5555/3295222.3295349',
            year: 2017,
            citationKey: 'vaswani2017',
            abstract: 'The dominant sequence transduction models...',
            metadata: {
              publicationTitle:
                'Advances in Neural Information Processing Systems',
              volume: '30',
              arxivId: '1706.03762',
            },
            contributors: [
              {
                creatorType: 'author',
                fullName: 'Ashish Vaswani',
                firstName: 'Ashish',
                lastName: 'Vaswani',
                orderIndex: 0,
              },
            ],
            itemTags: [{ tag: { id: 't1', name: 'transformers' } }],
            collectionItems: [
              { collection: { id: 'c1', name: 'Deep Learning' } },
            ],
            attachments: [
              {
                id: 'att1',
                filename: 'vaswani2017.pdf',
                mimeType: 'application/pdf',
              },
            ],
            notesList: [{ id: 'n1', content: 'Seminal paper' }],
          },
          {
            id: itemBId,
            title: 'Attention Is All You Need',
            itemType: 'conferencePaper',
            doi: '10.5555/3295222.3295349',
            year: 2017,
            citationKey: 'vaswani2017b',
            metadata: {
              proceedingsTitle: 'NIPS 2017',
              publisher: 'Curran Associates',
              pages: '5998-6008',
            },
            contributors: [
              {
                creatorType: 'author',
                fullName: 'Ashish Vaswani',
                firstName: 'Ashish',
                lastName: 'Vaswani',
                orderIndex: 0,
              },
            ],
            itemTags: [],
            collectionItems: [],
            attachments: [],
            notesList: [],
          },
        ]),
      };

      const duplicateService = new DuplicateService(
        new DuplicateDetectorService(mockCatalogGateway as never),
        new DuplicateMergerService({} as never, mockCatalogGateway as never),
      );

      const clusters = await duplicateService.detectDuplicates(userId);
      expect(clusters).toHaveLength(1);
      expect(clusters[0].recommendedMasterId).toBeDefined();
      expect([itemAId, itemBId]).toContain(clusters[0].recommendedMasterId);
      expect(clusters[0].items).toHaveLength(2);

      const hydratedA = clusters[0].items.find((i) => i.id === itemAId)!;
      expect(hydratedA.publicationTitle).toBe(
        'Advances in Neural Information Processing Systems',
      );
      expect(hydratedA.arxivId).toBe('1706.03762');
      expect(hydratedA.creators).toBeDefined();
      expect(hydratedA.tags).toContain('transformers');
      expect(hydratedA.attachments).toHaveLength(1);
    });
  });

  describe('Axis 4 — Return newAvailableFields from ItemTransformer.previewConversion', () => {
    it('computes newAvailableFields from targetType schema fields that were not on sourceType and are unpopulated', () => {
      const typesService = new TypesService();
      const transformer = new ItemTransformer(typesService);

      const rawItem = {
        id: '550e8400-e29b-41d4-a716-446655440099',
        title: 'Distributed Consensus in Fault-Tolerant Systems',
        itemType: 'journalArticle',
        year: 2024,
        publicationTitle: 'Journal of Distributed Computing',
        volume: '12',
        issue: '3',
        pages: '101-125',
        doi: '10.1000/jdc.2024.01',
        creators: [
          {
            creatorType: 'author',
            firstName: 'Leslie',
            lastName: 'Lamport',
            fullName: 'Leslie Lamport',
            orderIndex: 0,
          },
        ],
      };

      const preview = transformer.previewConversion(rawItem, 'patent');

      expect(preview.sourceType).toBe('journalArticle');
      expect(preview.targetType).toBe('patent');
      expect(Array.isArray(preview.newAvailableFields)).toBe(true);
      expect(preview.newAvailableFields.length).toBeGreaterThan(0);
      // Patent-specific fields not in journalArticle:
      expect(preview.newAvailableFields).toContain('patentNumber');
      expect(preview.newAvailableFields).toContain('assignee');
      expect(preview.newAvailableFields).toContain('issuingAuthority');
      // Shared fields like 'title' or 'url' should NOT be in newAvailableFields:
      expect(preview.newAvailableFields).not.toContain('title');
      expect(preview.newAvailableFields).not.toContain('url');

      // Same-type conversion returns empty newAvailableFields
      const sameTypePreview = transformer.previewConversion(
        rawItem,
        'journalArticle',
      );
      expect(sameTypePreview.newAvailableFields).toEqual([]);
    });
  });
});
