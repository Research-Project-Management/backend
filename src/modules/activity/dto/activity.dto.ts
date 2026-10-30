import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EntityType } from '@prisma/client';

export class RecentItemResponse {
  @ApiProperty()
  id!: string;

  @ApiPropertyOptional()
  type?: string;

  @ApiProperty({ enum: EntityType })
  entityType!: EntityType;

  @ApiProperty()
  entityId!: string;

  @ApiProperty()
  title!: string;

  @ApiPropertyOptional()
  projectId?: string | null;

  @ApiPropertyOptional()
  project?: {
    id: string;
    name?: string | null;
    identifier?: string | null;
  } | null;

  @ApiProperty()
  lastInteractedAt!: Date;

  @ApiPropertyOptional()
  updatedAt?: Date;
}

export class ActivityFeedItemResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: EntityType })
  entityType!: EntityType;

  @ApiProperty()
  entityId!: string;

  @ApiProperty()
  verb!: string;

  @ApiPropertyOptional()
  field?: string | null;

  @ApiPropertyOptional()
  oldValue?: string | null;

  @ApiPropertyOptional()
  newValue?: string | null;

  @ApiProperty()
  actorId!: string;

  @ApiPropertyOptional()
  projectId?: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiPropertyOptional()
  actor?: {
    id: string;
    name: string;
    email: string;
    avatar?: string | null;
  } | null;

  @ApiPropertyOptional()
  project?: {
    id: string;
    name: string;
  } | null;
}
