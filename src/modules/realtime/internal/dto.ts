import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class FlushDocsInternalDto {
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  docIds?: string[];
}

export class ApplyExternalTextInternalDto {
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  docId!: string;

  @IsString()
  text!: string;
}

export class EvictDocInternalDto {
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @IsString()
  @IsNotEmpty()
  docId!: string;
}

export class PresenceQueryInternalDto {
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @IsOptional()
  @IsString()
  docId?: string;
}
