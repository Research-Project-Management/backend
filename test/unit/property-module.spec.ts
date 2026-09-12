import { PropertyService } from '@/modules/work-item/property/property.service';
import { PropertyRepository } from '@/modules/work-item/property/property.repository';
import { PropertyController } from '@/modules/work-item/property/property.controller';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DEFAULT_FILTERS,
  DEFAULT_DISPLAY_FILTERS,
  DEFAULT_DISPLAY_PROPERTIES,
  DEFAULT_PREFERENCES,
} from '@/modules/work-item/property/types/property.types';

describe('Property Module (ProjectUserProperty - Plane.so Parity)', () => {
  let service: PropertyService;
  let controller: PropertyController;
  let mockRepo: {
    getOrCreate: jest.Mock;
    update: jest.Mock;
  };
  let mockEventEmitter: { emit: jest.Mock };

  const projectId = '11111111-1111-1111-1111-111111111111';
  const userId = '22222222-2222-2222-2222-222222222222';

  const mockPropertyRecord = {
    id: 'prop-1',
    projectId,
    project_id: projectId,
    userId,
    user_id: userId,
    filters: DEFAULT_FILTERS,
    displayFilters: DEFAULT_DISPLAY_FILTERS,
    display_filters: DEFAULT_DISPLAY_FILTERS,
    displayProperties: DEFAULT_DISPLAY_PROPERTIES,
    display_properties: DEFAULT_DISPLAY_PROPERTIES,
    richFilters: {},
    rich_filters: {},
    preferences: DEFAULT_PREFERENCES,
    sortOrder: 65535,
    sort_order: 65535,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    mockRepo = {
      getOrCreate: jest.fn().mockResolvedValue(mockPropertyRecord),
      update: jest.fn(),
    };

    mockEventEmitter = {
      emit: jest.fn(),
    };

    service = new PropertyService(
      mockRepo as unknown as PropertyRepository,
      mockEventEmitter as unknown as EventEmitter2,
    );

    controller = new PropertyController(service);
  });

  describe('PropertyService.getUserProperties', () => {
    it('should return default user properties when user first visits project (get-or-create)', async () => {
      const result = await service.getUserProperties(projectId, userId);

      expect(mockRepo.getOrCreate).toHaveBeenCalledWith(projectId, userId);
      expect(result).toBeDefined();
      expect(result.display_properties.assignee).toBe(true);
      expect(result.display_filters.layout).toBe('list');
      expect(result.display_filters.sub_issue).toBe(true);
      expect(result.preferences.pages.block_display).toBe(true);
    });
  });

  describe('PropertyService.updateUserProperties', () => {
    it('should update display properties and filters and emit event', async () => {
      const updateDto = {
        display_properties: {
          ...DEFAULT_DISPLAY_PROPERTIES,
          assignee: false,
          priority: false,
        },
        display_filters: {
          ...DEFAULT_DISPLAY_FILTERS,
          layout: 'kanban',
          group_by: 'state',
        },
        rich_filters: {
          and: [{ priority__is: 'urgent' }],
        },
      };

      const updatedRecord = {
        ...mockPropertyRecord,
        displayProperties: updateDto.display_properties,
        display_properties: updateDto.display_properties,
        displayFilters: updateDto.display_filters,
        display_filters: updateDto.display_filters,
        richFilters: updateDto.rich_filters,
        rich_filters: updateDto.rich_filters,
      };

      mockRepo.update.mockResolvedValue(updatedRecord);

      const result = await service.updateUserProperties(projectId, userId, updateDto);

      expect(mockRepo.update).toHaveBeenCalledWith(projectId, userId, {
        displayFilters: updateDto.display_filters,
        displayProperties: updateDto.display_properties,
        richFilters: updateDto.rich_filters,
      });

      expect(mockEventEmitter.emit).toHaveBeenCalledWith(
        'work-item.property.updated',
        expect.objectContaining({
          projectId,
          actorId: userId,
          changes: updateDto,
        }),
      );

      expect(result.display_properties.assignee).toBe(false);
      expect(result.display_filters.layout).toBe('kanban');
      expect(result.rich_filters.and).toHaveLength(1);
    });

    it('should accept camelCase properties interchangeably', async () => {
      const updateDto = {
        displayProperties: { assignee: true, priority: true },
        displayFilters: { layout: 'spreadsheet' },
        sortOrder: 100,
      };

      mockRepo.update.mockResolvedValue({
        ...mockPropertyRecord,
        displayProperties: updateDto.displayProperties,
        sortOrder: 100,
      });

      await service.updateUserProperties(projectId, userId, updateDto);

      expect(mockRepo.update).toHaveBeenCalledWith(projectId, userId, {
        displayProperties: updateDto.displayProperties,
        displayFilters: updateDto.displayFilters,
        sortOrder: 100,
      });
    });
  });

  describe('PropertyController', () => {
    it('getUserProperties should delegate to PropertyService', async () => {
      const result = await controller.getUserProperties(projectId, userId);

      expect(mockRepo.getOrCreate).toHaveBeenCalledWith(projectId, userId);
      expect(result.projectId).toBe(projectId);
    });

    it('updateUserProperties should delegate to PropertyService', async () => {
      const dto = {
        display_filters: { layout: 'calendar' },
      };
      mockRepo.update.mockResolvedValue({
        ...mockPropertyRecord,
        display_filters: { layout: 'calendar' },
      });

      const result = await controller.updateUserProperties(projectId, userId, dto);

      expect(result.display_filters.layout).toBe('calendar');
    });
  });
});
