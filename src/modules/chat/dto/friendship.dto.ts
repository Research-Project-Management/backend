import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SearchUsersDto {
  @ApiProperty({
    description: 'Search keyword (email or name)',
    example: 'alice',
  })
  @IsString()
  @IsNotEmpty({ message: 'Search query is required' })
  query!: string;
}

export class FriendshipActionDto {
  @ApiPropertyOptional({
    description: 'Optional note attached to friend request',
    example: 'Hey, let us collaborate on the Genome project!',
  })
  @IsString()
  @IsOptional()
  note?: string;
}
