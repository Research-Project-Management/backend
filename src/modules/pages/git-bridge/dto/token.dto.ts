/**
 * git-bridge/dto/token.dto.ts
 * Validated HTTP DTOs for Git Bridge endpoints.
 */

import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateTokenDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;
}

export class RepoQueryDto {
  @IsOptional()
  @IsUUID()
  pageId?: string;
}
