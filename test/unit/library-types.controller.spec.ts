import { NotFoundException } from '@nestjs/common';
import { TypesController } from '@/modules/library/catalog/presentation/types.controller';
import { TypesService } from '@/modules/library/catalog/application/services/types.service';
import { ZoteroSchemaValidatorService } from '@/modules/library/catalog/application/services/zotero-schema-validator.service';

describe('TypesController & Zotero Schema Endpoints', () => {
  let controller: TypesController;
  let service: TypesService;
  let validator: ZoteroSchemaValidatorService;

  beforeEach(() => {
    service = new TypesService();
    validator = new ZoteroSchemaValidatorService(service);
    controller = new TypesController(service, validator);
  });

  describe('listAllItemTypes', () => {
    it('should return itemTypes and schema mappings', () => {
      const result = controller.listAllItemTypes();
      expect(result.success).toBe(true);
      expect(result.schemaVersion).toBe(42);
      expect(Array.isArray(result.itemTypes)).toBe(true);
      expect(result.itemTypes.length).toBeGreaterThan(30);

      // Verify schema mappings are served by backend
      expect(result.baseFieldMappings).toBeDefined();
      expect(result.baseFieldMappings.journalArticle).toBeDefined();
      expect(result.creatorRoles).toBeDefined();
      expect(result.creatorRoles.author).toBeDefined();
      expect(result.cslTypeMap).toBeDefined();
      expect(result.cslFieldMap).toBeDefined();
    });
  });

  describe('getSchemaSnapshot', () => {
    it('should return full Zotero schema snapshot', () => {
      const result = controller.getSchemaSnapshot();
      expect(result.success).toBe(true);
      expect(result.version).toBe(42);
      expect(result.source).toContain('zotero');
      expect(result.itemTypes).toBeDefined();
      expect(result.itemTypes.journalArticle).toBeDefined();
      expect(result.itemTypes.journalArticle.primaryCreatorType).toBe('author');
      expect(result.baseFieldMappings).toBeDefined();
    });
  });

  describe('getItemTypeDefinition', () => {
    it('should return definition for journalArticle', () => {
      const result = controller.getItemTypeDefinition('journalArticle');
      expect(result.success).toBe(true);
      expect(result.itemType.itemType).toBe('journalArticle');
      expect(result.itemType.primaryCreatorType).toBe('author');
      expect(result.itemType.fields.length).toBeGreaterThan(0);
    });

    it('should throw NotFoundException for invalid item type', () => {
      expect(() => controller.getItemTypeDefinition('nonExistentType')).toThrow(
        NotFoundException,
      );
    });
  });
});
