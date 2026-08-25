import { IsNotEmpty, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class OAuthExchangeDto {
  @ApiProperty({
    description: 'Single-use OAuth exchange ticket obtained from callback',
    example: 'd41d8cd98f00b204e9800998ecf8427e',
  })
  @IsString()
  @IsNotEmpty({ message: 'Exchange code is required' })
  code!: string;
}
