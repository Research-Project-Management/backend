import {
  IsUrl,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  IsNumber,
  IsArray,
  IsBoolean,
  IsIn,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  SCHEMA_V42_DATA,
  ALL_CREATOR_ROLES,
} from '@/modules/library/core/types/schema.constants';

const VALID_CREATOR_ROLES = Object.keys(ALL_CREATOR_ROLES);
const VALID_ITEM_TYPES = [
  ...Object.keys(SCHEMA_V42_DATA.itemTypes),
  'article',
  'paper',
  'incollection',
  'inproceedings',
  'phdthesis',
  'mastersthesis',
  'techreport',
  'misc',
  'unpublished',
];

export class CreatorDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  fullName?: string;

  @IsOptional()
  @IsNumber()
  fieldMode?: number;

  @IsOptional()
  @IsIn(VALID_CREATOR_ROLES, {
    message: 'creatorType must be a valid Zotero creator role',
  })
  creatorType?: string;
}

export class CaptureUrlDto {
  @IsNotEmpty()
  @IsUrl(
    { require_protocol: true, protocols: ['http', 'https'] },
    { message: 'Valid HTTP or HTTPS URL is required' },
  )
  @MaxLength(2048)
  url!: string;
}

export class ConfirmCapturedUrlDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(15000)
  abstract?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  doi?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  url?: string;

  @IsOptional()
  @IsNumber()
  year?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  publicationTitle?: string;

  @IsNotEmpty({ message: 'Cryptographic previewToken is strictly required' })
  @IsString()
  previewToken!: string;

  @IsOptional()
  @IsBoolean()
  userOverride?: boolean;

  @IsOptional()
  @IsString()
  @IsIn(VALID_ITEM_TYPES, {
    message: 'itemType must be a valid Zotero item type',
  })
  itemType?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  tags?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => CreatorDto)
  creators?: CreatorDto[];

  @IsOptional()
  @IsString()
  collectionId?: string;

  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  idempotencyKey?: string;
}
