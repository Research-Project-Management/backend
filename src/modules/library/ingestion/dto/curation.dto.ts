import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateReviewCaseStatusDto {
  @IsIn(['OPEN', 'PENDING', 'APPROVED', 'REJECTED', 'DISMISSED', 'RESOLVED'])
  status!:
    'OPEN' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'DISMISSED' | 'RESOLVED';

  @IsOptional()
  @IsUUID(undefined, { message: 'spaceId must be a valid UUID' })
  spaceId?: string;
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
  @IsUUID(undefined, { message: 'spaceId must be a valid UUID' })
  spaceId?: string;
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
  @IsUUID(undefined, { message: 'spaceId must be a valid UUID' })
  spaceId?: string;
}

export class BatchMergeDuplicatesDto {
  @IsArray()
  @ArrayNotEmpty({ message: 'merges must contain at least one merge group' })
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => MergeDuplicatesDto)
  merges!: MergeDuplicatesDto[];

  @IsOptional()
  @IsUUID(undefined, { message: 'spaceId must be a valid UUID' })
  spaceId?: string;
}
