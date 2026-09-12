import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PropertyRepository } from './property.repository';
import { UpdatePropertyDto } from './dto/property.dto';

@Injectable()
export class PropertyService {
  constructor(
    private readonly propertyRepository: PropertyRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async getUserProperties(projectId: string, userId: string): Promise<any> {
    return this.propertyRepository.getOrCreate(projectId, userId);
  }

  async updateUserProperties(
    projectId: string,
    userId: string,
    updatePropertyDto: UpdatePropertyDto,
  ): Promise<any> {
    const displayFilters = updatePropertyDto.display_filters ?? updatePropertyDto.displayFilters;
    const displayProperties = updatePropertyDto.display_properties ?? updatePropertyDto.displayProperties;
    const richFilters = updatePropertyDto.rich_filters ?? updatePropertyDto.richFilters;
    const sortOrder = updatePropertyDto.sort_order ?? updatePropertyDto.sortOrder;

    const updated = await this.propertyRepository.update(projectId, userId, {
      ...(updatePropertyDto.filters !== undefined && { filters: updatePropertyDto.filters }),
      ...(displayFilters !== undefined && { displayFilters }),
      ...(displayProperties !== undefined && { displayProperties }),
      ...(richFilters !== undefined && { richFilters }),
      ...(updatePropertyDto.preferences !== undefined && { preferences: updatePropertyDto.preferences }),
      ...(sortOrder !== undefined && { sortOrder }),
    });

    this.eventEmitter.emit('work-item.property.updated', {
      projectId,
      actorId: userId,
      changes: updatePropertyDto,
    });

    return updated;
  }
}
