import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class JoinByCodeDto {
  @ApiProperty({ description: 'Invite token, invite hash, or project identifier code', example: 'TT2' })
  @IsString()
  @IsNotEmpty()
  code!: string;
}
