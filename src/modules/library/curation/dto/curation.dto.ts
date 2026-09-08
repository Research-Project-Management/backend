import {
  IsUUID,
  IsArray,
  ArrayNotEmpty,
  IsOptional,
  IsObject,
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
}
