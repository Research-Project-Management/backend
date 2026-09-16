import { ArrayNotEmpty, IsArray, IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AssignProjectLabelsDto {
  @ApiProperty({
    description: 'Array of ProjectLabel UUIDs to assign to this project',
    example: ['11111111-2222-3333-4444-555555555555'],
  })
  @IsArray()
  @ArrayNotEmpty({ message: 'labelIds array must not be empty' })
  @IsUUID('4', { each: true, message: 'Each labelId must be a valid UUID v4' })
  labelIds!: string[];
}
