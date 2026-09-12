import { IsBoolean, IsObject, IsOptional } from 'class-validator';
import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { CreateProjectDto } from './create.dto';

/**
 * DTO for updating an existing research project.
 */
export class UpdateProjectDto extends PartialType(CreateProjectDto) {
  @ApiPropertyOptional({
    description:
      'Whether the project is active (false when soft-deleted or archived)',
    example: true,
  })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Whether the project is archived (frozen/hidden)',
    example: false,
  })
  @IsBoolean()
  @IsOptional()
  isArchived?: boolean;

  @ApiPropertyOptional({
    description: 'Whether the current user has favorited this project',
    example: true,
  })
  @IsBoolean()
  @IsOptional()
  isFavorite?: boolean;

  @ApiPropertyOptional({
    description: 'Custom settings object for project behavior',
    example: { defaultAssigneeId: null, parallelCycles: false },
  })
  @IsObject()
  @IsOptional()
  settings?: Record<string, unknown>;
}
