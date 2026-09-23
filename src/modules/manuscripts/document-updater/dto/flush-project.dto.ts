/**
 * document-updater/dto/flush-project.dto.ts
 */

import { IsBoolean, IsOptional } from 'class-validator';

export class FlushProjectDto {
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
