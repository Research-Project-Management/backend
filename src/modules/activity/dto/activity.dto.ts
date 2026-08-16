import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EntityType } from '@prisma/client';

export class RecentItemResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: EntityType })
  entityType!: EntityType;

  @ApiProperty()
  entityId!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  workspaceId!: string;

  @ApiPropertyOptional()
  projectId?: string | null;

  @ApiProperty()
  lastInteractedAt!: Date;
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

  @ApiProperty()
  workspaceId!: string;

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
