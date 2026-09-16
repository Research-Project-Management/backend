import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectPriority, ProjectState } from '@prisma/client';

/**
 * DTO representing minimal project user (Lead / Creator / Member).
 */
export class ProjectUserSummaryDto {
  @ApiProperty({ example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
  id!: string;

  @ApiProperty({ example: 'Marie Curie' })
  name!: string;

  @ApiPropertyOptional({ example: 'marie@curie.org' })
  email?: string | null;

  @ApiPropertyOptional({ example: 'https://example.com/avatar.png' })
  avatar?: string | null;
}

/**
 * DTO representing a project label.
 */
export class ProjectLabelSummaryDto {
  @ApiProperty({ example: 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22' })
  id!: string;

  @ApiProperty({ example: 'Infrastructure' })
  name!: string;

  @ApiProperty({ example: '#3B82F6' })
  color!: string;

  @ApiPropertyOptional({ example: 'Platform infra' })
  description?: string | null;
}

/**
 * DTO representing a member inside a project response.
 */
export class ProjectMemberSummaryDto {
  @ApiProperty({ example: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33' })
  id!: string;

  @ApiProperty({ example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
  userId!: string;

  @ApiProperty({
    example: 'owner',
    enum: ['owner', 'contributor', 'commenter', 'viewer'],
  })
  role!: string;

  @ApiProperty({ example: '2026-09-12T00:00:00.000Z' })
  joinedAt!: Date | string;

  @ApiProperty({ type: ProjectUserSummaryDto })
  user!: ProjectUserSummaryDto;
}

/**
 * DTO representing server-authoritative granular project permissions.
 */
export class ProjectPermissionsDto {
  @ApiProperty({ example: true })
  canEdit!: boolean;

  @ApiProperty({ example: true })
  canDelete!: boolean;

  @ApiProperty({ example: true })
  canArchive!: boolean;

  @ApiProperty({ example: true })
  canManageMembers!: boolean;

  @ApiProperty({ example: true })
  canLeave!: boolean;
}

/**
 * DTO representing a project in API responses.
 */
export class ProjectResponseDto {
  @ApiProperty({ example: 'p0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44' })
  id!: string;

  @ApiProperty({ example: 'Deep Learning for Genome Analysis' })
  name!: string;

  @ApiPropertyOptional({ example: 'DLGA' })
  identifier?: string | null;

  @ApiPropertyOptional({ example: '🧬' })
  avatar?: string | null;

  @ApiPropertyOptional({ example: 'https://example.com/cover.png' })
  coverImage?: string | null;

  @ApiPropertyOptional({ example: 'Investigating transformer architectures.' })
  description?: string | null;

  @ApiProperty({ enum: ProjectState, example: ProjectState.execution })
  state!: ProjectState;

  @ApiProperty({ enum: ProjectPriority, example: ProjectPriority.high })
  priority!: ProjectPriority;

  @ApiPropertyOptional({ example: '2026-10-01' })
  startDate?: Date | string | null;

  @ApiPropertyOptional({ example: '2026-12-31' })
  targetDate?: Date | string | null;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ example: false })
  isArchived!: boolean;

  @ApiPropertyOptional({ example: null })
  archivedAt?: Date | string | null;

  @ApiPropertyOptional({ example: false })
  isFavorite?: boolean;

  @ApiProperty({
    example: ['work_items', 'cycles', 'views', 'pages'],
  })
  modules!: string[];

  @ApiPropertyOptional({ type: [ProjectLabelSummaryDto] })
  labels?: ProjectLabelSummaryDto[];

  @ApiPropertyOptional({ type: [ProjectMemberSummaryDto] })
  members?: ProjectMemberSummaryDto[];

  @ApiPropertyOptional({ example: {} })
  settings?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    example: 'owner',
    enum: ['owner', 'contributor', 'commenter', 'viewer'],
  })
  yourRole?: string | null;

  @ApiPropertyOptional({ type: ProjectPermissionsDto })
  permissions?: ProjectPermissionsDto;

  @ApiProperty({ example: '2026-09-12T00:00:00.000Z' })
  createdAt!: Date | string;

  @ApiProperty({ example: '2026-09-12T00:00:00.000Z' })
  updatedAt!: Date | string;
}

/**
 * DTO for project detail API response.
 */
export class ProjectDetailResponseDto {
  @ApiProperty({ type: ProjectResponseDto })
  project!: ProjectResponseDto;

  @ApiPropertyOptional({
    example: 'owner',
    enum: ['owner', 'contributor', 'commenter', 'viewer'],
  })
  yourRole?: string | null;

  @ApiPropertyOptional({ type: ProjectPermissionsDto })
  permissions?: ProjectPermissionsDto;
}

/**
 * DTO for project list API response.
 */
export class ProjectListResponseDto {
  @ApiProperty({ type: [ProjectResponseDto] })
  projects!: ProjectResponseDto[];

  @ApiPropertyOptional({ type: [ProjectResponseDto] })
  myProjects?: ProjectResponseDto[];

  @ApiPropertyOptional({ type: [ProjectResponseDto] })
  sharedProjects?: ProjectResponseDto[];

  @ApiProperty({ example: 1 })
  total!: number;
}
