import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class SetKillSwitchDto {
  @IsBoolean()
  disabled!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(255)
  reason?: string;

  @IsOptional()
  @IsString()
  workspaceId?: string;
}
