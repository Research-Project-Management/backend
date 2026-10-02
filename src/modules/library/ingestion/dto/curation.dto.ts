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
  @IsUUID(undefined, { message: 'primaryItemId must be a valid UUID' })
  primaryItemId!: string;

  @IsArray()
  @ArrayNotEmpty({ message: 'duplicateItemIds must contain at least one ID' })
  @IsUUID(undefined, {
    each: true,
    message: 'Each duplicateItemId must be a valid UUID',
  })
  duplicateItemIds!: string[];

  @IsOptional()
  @IsObject()
  fieldSelections?: Record<string, unknown>;

  @IsOptional()
  @IsUUID(undefined, { message: 'projectId must be a valid UUID' })
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
  @IsUUID(undefined, { message: 'projectId must be a valid UUID' })
  projectId?: string;
}
