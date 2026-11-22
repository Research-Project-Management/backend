import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { TagType } from '@prisma/client';

export class CreateTagDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  color?: string;

  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsInt()
  @Min(1)
  @Max(9)
  @IsOptional()
  shortcut?: number | null;

  @IsEnum(TagType)
  @IsOptional()
  type?: TagType;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @IsInt()
  expectedVersion?: number;
}

export class UpdateTagDto {
  @IsString()
  @IsOptional()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  color?: string;

  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsInt()
  @Min(1)
  @Max(9)
  @IsOptional()
  shortcut?: number | null;

  @IsEnum(TagType)
  @IsOptional()
  type?: TagType;

  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @IsInt()
  expectedVersion?: number;
}

export class SplitTagDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  parts!: string[];

  @IsOptional()
  @IsUUID()
  spaceId?: string;
}
