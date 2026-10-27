import {
  IsString,
  IsNotEmpty,
  IsOptional,
  MinLength,
  MaxLength,
  IsEnum,
  IsInt,
  Min,
  Max,
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

  @IsString()
  @IsOptional()
  @MaxLength(100)
  projectId?: string;
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

  @IsString()
  @IsOptional()
  @MaxLength(100)
  projectId?: string;
}
