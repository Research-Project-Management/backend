import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID } from 'class-validator';

export class TransferOwnershipDto {
  @ApiProperty({
    description: 'User ID of the existing project member to promote to Owner',
    example: '018f3a5b-7c9d-7000-8000-123456789abc',
  })
  @IsUUID('all', { message: 'newOwnerId must be a valid canonical UUID' })
  @IsNotEmpty()
  newOwnerId!: string;
}
