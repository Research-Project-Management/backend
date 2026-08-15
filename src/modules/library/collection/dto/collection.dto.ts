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
