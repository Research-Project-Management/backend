import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export type UserEntityType =
  | 'project'
  | 'task'
  | 'paper'
  | 'page'
  | 'file'
  | 'folder'
  | 'sticky';

export class UserSearchResultItem {
  @ApiProperty({
    enum: ['project', 'task', 'paper', 'page', 'file', 'folder', 'sticky'],
    example: 'project',
  })
  type!: UserEntityType;

  @ApiProperty({ example: 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33' })
  id!: string;

  @ApiProperty({ example: 'Deep Learning for NLP' })
  name!: string;

  @ApiPropertyOptional({ example: 'NLP-101' })
  identifier?: string | null;

  @ApiPropertyOptional({ example: 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44' })
  projectId?: string | null;

  @ApiPropertyOptional({ example: 'NLP Research Group' })
  projectName?: string | null;

  @ApiPropertyOptional({ example: 'folder' })
  icon?: string | null;

  @ApiPropertyOptional({ example: '#3B82F6' })
  color?: string | null;

  @ApiPropertyOptional({ example: 'application/pdf' })
  mimeType?: string | null;

  @ApiPropertyOptional({ example: 1048576 })
  size?: number | null;

  @ApiProperty({ example: '2026-09-12T00:00:00.000Z' })
  updatedAt!: Date;
}
