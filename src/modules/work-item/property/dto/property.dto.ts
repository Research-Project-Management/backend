import { IsOptional, IsObject, IsNumber } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdatePropertyDto {
  @ApiPropertyOptional({
    description: 'Basic filter options (Plane.so filters format)',
    example: { priority: ['high', 'urgent'], state: null },
  })
  @IsOptional()
  @IsObject()
  filters?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Display options such as layout, group_by, order_by (camelCase)',
    example: { layout: 'kanban', group_by: 'state', order_by: '-created_at' },
  })
  @IsOptional()
  @IsObject()
  displayFilters?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Display options such as layout, group_by, order_by (snake_case)',
    example: { layout: 'kanban', group_by: 'state', order_by: '-created_at' },
  })
  @IsOptional()
  @IsObject()
  display_filters?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Toggle which property badges/columns show up on cards (camelCase)',
    example: { assignee: true, priority: true, due_date: true, labels: true },
  })
  @IsOptional()
  @IsObject()
  displayProperties?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Toggle which property badges/columns show up on cards (snake_case)',
    example: { assignee: true, priority: true, due_date: true, labels: true },
  })
  @IsOptional()
  @IsObject()
  display_properties?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Rich filter expressions with operators (camelCase)',
    example: { and: [{ priority__is: 'urgent' }] },
  })
  @IsOptional()
  @IsObject()
  richFilters?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Rich filter expressions with operators (snake_case)',
    example: { and: [{ priority__is: 'urgent' }] },
  })
  @IsOptional()
  @IsObject()
  rich_filters?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'User view/page preferences',
    example: { pages: { block_display: true } },
  })
  @IsOptional()
  @IsObject()
  preferences?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Sort order for project ordering (camelCase)',
    example: 65535,
  })
  @IsOptional()
  @IsNumber()
  sortOrder?: number;

  @ApiPropertyOptional({
    description: 'Sort order for project ordering (snake_case)',
    example: 65535,
  })
  @IsOptional()
  @IsNumber()
  sort_order?: number;
}
