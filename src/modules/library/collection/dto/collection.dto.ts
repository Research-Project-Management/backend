import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateCollectionDto {
  @IsString()
  @IsNotEmpty({ message: 'Collection name is required' })
  name!: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  color?: string;

  @IsString()
  @IsOptional()
  icon?: string;

  @IsString()
  @IsOptional()
  parent?: string;

  @IsString()
  @IsOptional()
  parentId?: string;
}

export class UpdateCollectionDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @IsOptional()
  color?: string;

  @IsString()
  @IsOptional()
  icon?: string;

  @IsString()
  @IsOptional()
  parent?: string;

  @IsString()
  @IsOptional()
  parentId?: string;
}

export class MovePapersDto {
  @IsNotEmpty({ message: 'paperIds array is required' })
  paperIds!: string[];
}

export class ReorderItemDto {
  @IsString()
  @IsNotEmpty()
  id!: string;

  @IsString()
  @IsOptional()
  parentId?: string | null;
}

export class ReorderCollectionsDto {
  @IsNotEmpty({ message: 'collections array is required' })
  collections!: ReorderItemDto[];
}

export class DeleteCollectionQueryDto {
  @IsString()
  @IsOptional()
  strategy?: 'cascade' | 'move-to-parent' | 'orphan';
}

export class AssignPapersToCollectionDto {
  @IsNotEmpty({ message: 'paperIds array is required' })
  paperIds!: string[];
}

export class ProjectCollectionQueryDto {
  @IsString()
  @IsOptional()
  projectId?: string;
}

