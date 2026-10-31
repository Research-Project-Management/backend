import { IsNotEmpty, IsString } from 'class-validator';

export class ConnectApiKeyDto {
  @IsNotEmpty()
  @IsString()
  zoteroUserId!: string;

  @IsNotEmpty()
  @IsString()
  apiKey!: string;
}
