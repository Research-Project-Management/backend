import {
  IsString,
  IsOptional,
  IsNumber,
  IsNotEmpty,
  IsBoolean,
  IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';

export class MoveNodeDto {
  @ApiPropertyOptional({
    description:
      'Target parent node ID. Null or omitted moves node to root level',
    nullable: true,
  })
  @IsOptional()
  @IsUUID()
  targetParentId?: string | null;

  @ApiPropertyOptional({
    description: 'New rank order within the sibling list',
    default: 0,
  })
  @IsOptional()
  @IsNumber()
  rank?: number;
}

export const MoveTreeItemDto = MoveNodeDto;
export type MoveTreeItemDto = MoveNodeDto;

export class CreateChildNodeDto {
  @ApiProperty({ description: 'Title or filename of the child node' })
  @IsString()
  @IsNotEmpty({ message: 'Node title is required' })
  title!: string;

  @ApiPropertyOptional({ description: 'Parent node ID' })
  @IsOptional()
  @IsUUID()
  parentPageId?: string;

  @ApiPropertyOptional({ description: 'Initial content (text or JSON)' })
  @IsOptional()
  content?: Prisma.InputJsonValue;

  @ApiPropertyOptional({ description: 'Rank ordering' })
  @IsOptional()
  @IsNumber()
  rank?: number;

  @ApiPropertyOptional({ description: 'Optional icon identifier' })
  @IsOptional()
  @IsString()
  icon?: string;

  @ApiPropertyOptional({
    description: 'Whether this node represents a folder or grouping section',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isFolder?: boolean;
}

export class SetMainNodeDto {
  @ApiProperty({
    description:
      'ID of the file to designate as main entrypoint (e.g. main.tex)',
  })
  @IsUUID()
  @IsNotEmpty()
  mainFileId!: string;
}

export interface NodeTreeItem {
  id: string;
  title: string;
  slug?: string | null;
  icon?: string | null;
  rank: number;
  status: string;
  isLocked: boolean;
  parentPageId: string | null;
  mainFileId: string | null;
  projectId: string;
  createdAt: Date;
  updatedAt: Date;
  children?: NodeTreeItem[];
}

export type TreeItem = NodeTreeItem;
