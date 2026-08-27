import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { LabelType } from '@prisma/client';

export class QueryLabelDto {
  @IsEnum(LabelType)
  @IsOptional()
  type?: LabelType;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;
}

export class CreateLabelDto {
  @IsString()
  @IsNotEmpty({ message: 'Label name is required' })
  name!: string;

  @IsString()
  @IsOptional()
  color?: string;

  @IsEnum(LabelType)
  @IsOptional()
  type?: LabelType;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;
}

export class UpdateLabelDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  color?: string;

  @IsEnum(LabelType)
  @IsOptional()
  type?: LabelType;

  @IsString()
  @IsOptional()
  projectId?: string;

  @IsString()
  @IsOptional()
  workspaceId?: string;
}
