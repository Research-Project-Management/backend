import { IsNotEmpty, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateDirectChatDto {
  @ApiProperty({
    description: 'Target user ID to start a 1-1 direct conversation with',
    example: '01957c91-2345-7890-abcd-ef0123456789',
  })
  @IsUUID('all', { message: 'Target user ID must be a valid UUID' })
  @IsNotEmpty({ message: 'Target user ID is required' })
  targetUserId!: string;
}
