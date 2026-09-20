import {
  IsUUID,
  IsArray,
  ArrayNotEmpty,
  IsOptional,
  IsObject,
  IsString,
  IsIn,
} from 'class-validator';

export class MergeDuplicatesDto {
  @IsUUID('4', { message: 'primaryItemId must be a valid UUID v4' })
  primaryItemId!: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'duplicateItemIds must contain at least one ID' })
  @IsUUID('4', {
    each: true,
    message: 'Each duplicateItemId must be a valid UUID v4',
  })
  duplicateItemIds!: string[];

  @IsOptional()
  @IsObject()
  fieldSelections?: Record<string, unknown>;

  @IsOptional()
  @IsUUID('4', { message: 'projectId must be a valid UUID v4' })
  projectId?: string;
}

export type AutoResolveStrategy = 'newest' | 'most_complete' | 'first_created';

export class AutoResolveClusterDto {
  @IsString({ message: 'clusterId must be a string' })
  clusterId!: string;

  @IsOptional()
  @IsIn(['newest', 'most_complete', 'first_created'], {
    message: 'strategy must be one of newest, most_complete, first_created',
  })
  strategy?: AutoResolveStrategy;

  @IsOptional()
  @IsUUID('4', { message: 'projectId must be a valid UUID v4' })
  projectId?: string;
}
