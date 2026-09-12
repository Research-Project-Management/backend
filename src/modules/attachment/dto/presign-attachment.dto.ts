import { IsEnum, IsNotEmpty, IsOptional, IsString, IsInt, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EntityType } from '@prisma/client';

export class PresignAttachmentDto {
  @ApiProperty({ description: 'Original filename with extension', example: 'design_spec.pdf' })
  @IsNotEmpty()
  @IsString()
  filename!: string;

  @ApiProperty({ enum: EntityType, description: 'Entity type: task, comment, page, sticky, project, worklog', example: 'task' })
  @IsNotEmpty()
  @IsEnum(EntityType)
  entityType!: EntityType;

  @ApiProperty({ description: 'ID of the entity this attachment belongs to', example: 'b1a2c3d4-0000-0000-0000-000000000000' })
  @IsNotEmpty()
  @IsString()
  entityId!: string;

  @ApiPropertyOptional({ description: 'MIME type of the file', example: 'application/pdf' })
  @IsOptional()
  @IsString()
  contentType?: string;

  @ApiPropertyOptional({ description: 'File size in bytes', example: 1048576 })
  @IsOptional()
  @IsInt()
  @Min(1)
  size?: number;

  @ApiPropertyOptional({ description: 'Workspace ID' })
  @IsOptional()
  @IsString()
  workspaceId?: string;

  @ApiPropertyOptional({ description: 'Project ID' })
  @IsOptional()
  @IsString()
  projectId?: string;
}
