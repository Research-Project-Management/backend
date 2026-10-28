import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  ArrayMaxSize,
  MaxLength,
} from 'class-validator';

export class SubscribeFeedDto {
  @IsString()
  @MaxLength(2048)
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  customTitle?: string;

  @IsOptional()
  @IsNumber()
  cleanupDays?: number;

  @IsOptional()
  @IsNumber()
  cleanupReadAfter?: number;

  @IsOptional()
  @IsNumber()
  cleanupUnreadAfter?: number;
}

export class UpdateFeedSubDto {
  @IsOptional()
  @IsString()
  @MaxLength(255)
  customTitle?: string;

  @IsOptional()
  @IsNumber()
  cleanupDays?: number;

  @IsOptional()
  @IsNumber()
  cleanupReadAfter?: number;

  @IsOptional()
  @IsNumber()
  cleanupUnreadAfter?: number;

  @IsOptional()
  @IsString()
  url?: string;
}

export class MarkItemReadDto {
  @IsOptional()
  @IsBoolean()
  isRead?: boolean;
}

export class MarkAllReadDto {
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  itemIds!: string[];
}
