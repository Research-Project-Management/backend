import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
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

export class ImportOpmlDto {
  @IsString()
  @MaxLength(500000)
  opmlXml!: string;
}

export class FetchAcademicFeedDto {
  @IsNotEmpty()
  @IsUrl(
    { require_protocol: true, protocols: ['http', 'https'] },
    { message: 'Valid HTTP or HTTPS URL is required' },
  )
  @MaxLength(2048)
  url!: string;

  @IsOptional()
  @IsBoolean()
  forceRefresh?: boolean;
}
