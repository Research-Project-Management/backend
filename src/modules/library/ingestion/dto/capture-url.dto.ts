import {
  IsUrl,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  IsNumber,
  IsArray,
  IsBoolean,
  IsEnum,
  ArrayMaxSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreatorDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  lastName!: string;

  @IsOptional()
  @IsEnum(['author', 'editor', 'contributor', 'translator'], {
    message:
      'creatorType must be one of: author, editor, contributor, translator',
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
  @IsEnum(
    [
      'journalArticle',
      'book',
      'bookSection',
      'conferencePaper',
      'preprint',
      'report',
      'thesis',
      'webpage',
      'manuscript',
      'dataset',
      'document',
    ],
    {
      message:
        'itemType must be one of: journalArticle, book, bookSection, conferencePaper, preprint, report, thesis, webpage, manuscript, dataset, document',
    },
  )
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
}
