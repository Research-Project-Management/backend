import { IsBoolean, IsNotEmpty, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ToggleLinkSharingDto {
  @ApiProperty({
    description: 'Whether link sharing is active for this project',
    example: true,
  })
  @IsBoolean()
  @IsNotEmpty()
  enabled!: boolean;

  @ApiPropertyOptional({
    description: 'Optionally regenerate fresh invite tokens',
    example: false,
  })
  @IsBoolean()
  @IsOptional()
  regenerate?: boolean;
}
