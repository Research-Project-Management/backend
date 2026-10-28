import {
  IsUUID,
  IsArray,
  ArrayNotEmpty,
  IsOptional,
  IsObject,
  IsIn,
} from 'class-validator';

export class UpdateReviewCaseStatusDto {
  @IsIn(['OPEN', 'PENDING', 'APPROVED', 'REJECTED', 'DISMISSED', 'RESOLVED'])
  status!:
    | 'OPEN'
    | 'PENDING'
    | 'APPROVED'
    | 'REJECTED'
    | 'DISMISSED'
    | 'RESOLVED';

  @IsOptional()
  @IsUUID(undefined, { message: 'projectId must be a valid UUID' })
  projectId?: string;
}

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

export class DismissDuplicatesDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'itemIds must contain at least two IDs' })
  @IsUUID(undefined, {
    each: true,
    message: 'Each itemId must be a valid UUID',
  })
  itemIds!: string[];

  @IsOptional()
  @IsUUID(undefined, { message: 'projectId must be a valid UUID' })
  projectId?: string;
}

export class UndoMergeDuplicatesDto {
  @IsUUID(undefined, { message: 'primaryItemId must be a valid UUID' })
  primaryItemId!: string;

  @IsOptional()
  @IsUUID(undefined, { message: 'projectId must be a valid UUID' })
  projectId?: string;
}

