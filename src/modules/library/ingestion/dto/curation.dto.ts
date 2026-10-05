import {
  IsUUID,
  IsArray,
  ArrayNotEmpty,
  IsOptional,
  IsObject,
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
