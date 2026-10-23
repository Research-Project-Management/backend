import {
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateGroupChatDto {
  @ApiProperty({
    description: 'Name of the group chat',
    example: 'GenAI Study Group',
    maxLength: 100,
  })
  @IsString()
  @IsNotEmpty({ message: 'Group name is required' })
  @MaxLength(100, { message: 'Group name cannot exceed 100 characters' })
  name!: string;

  @ApiPropertyOptional({
    description: 'Optional group topic or description',
    example: 'Weekly paper discussion',
    maxLength: 255,
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  topic?: string;

  @ApiPropertyOptional({
    description: 'Optional avatar URL for the group',
  })
  @IsString()
  @IsOptional()
  avatar?: string;

  @ApiPropertyOptional({
    description: 'Initial member user IDs to add to the group',
    example: ['01957c91-2345-7890-abcd-ef0123456789'],
  })
  @IsArray()
  @IsUUID('all', { each: true, message: 'Each member ID must be a valid UUID' })
  @IsOptional()
  memberIds?: string[];
}
