import { IsArray, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ChatQueryDto {
  @IsString()
  @IsNotEmpty({ message: 'Query is required' })
  query!: string;

  @IsArray()
  @IsOptional()
  messages?: Array<Record<string, unknown>>;

  @IsArray()
  @IsOptional()
  selected_files?: string[];

  @IsArray()
  @IsOptional()
  document_ids?: string[];

  @IsString()
  @IsOptional()
  chat_id?: string;

  @IsString()
  @IsOptional()
  workspace_id?: string;

  @IsString()
  @IsOptional()
  page_id?: string;
}
