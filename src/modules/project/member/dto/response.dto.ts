import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Role } from '@prisma/client';

export class MinimalUserDto {
  @ApiProperty({ example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
  id!: string;

  @ApiProperty({ example: 'Marie Curie' })
  name!: string;

  @ApiPropertyOptional({ example: 'marie@curie.org' })
  email?: string | null;

  @ApiPropertyOptional({ example: 'https://example.com/avatar.png' })
  avatar?: string | null;
}

export class ProjectMemberResponseDto {
  @ApiProperty({ example: 'm0eebc99-9c0b-4ef8-bb6d-6bb9bd380a55' })
  id!: string;

  @ApiProperty({ example: 'p0eebc99-9c0b-4ef8-bb6d-6bb9bd380a44' })
  projectId!: string;

  @ApiProperty({ example: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' })
  userId!: string;

  @ApiProperty({
    enum: Role,
    example: Role.contributor,
  })
  role!: Role;

  @ApiProperty({ example: '2026-09-12T00:00:00.000Z' })
  joinedAt!: Date | string;

  @ApiProperty({ type: MinimalUserDto })
  user!: MinimalUserDto;
}

export class ProjectMemberListResponseDto {
  @ApiProperty({ type: [ProjectMemberResponseDto] })
  members!: ProjectMemberResponseDto[];

  @ApiProperty({ example: 1 })
  total!: number;

  @ApiPropertyOptional({ example: 1 })
  page?: number;

  @ApiPropertyOptional({ example: 50 })
  limit?: number;
}
