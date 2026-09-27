import { IsOptional, IsString } from 'class-validator';

export class InitiateOAuthQueryDto {
  @IsOptional()
  @IsString()
  redirectUri?: string;
}
