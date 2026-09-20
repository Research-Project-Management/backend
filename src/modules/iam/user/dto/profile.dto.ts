import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({
    description: 'Full name of user',
    example: 'John Doe',
  })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({
    description: 'Avatar URL or file path',
    example: 'https://example.com/avatar.jpg',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  avatar?: string | null;

  @ApiPropertyOptional({
    description: 'Academic biography',
    example: 'Postdoctoral researcher in Computer Science',
  })
  @IsOptional()
  @IsString()
  bio?: string;

  @ApiPropertyOptional({
    description: 'Institution or university affiliation',
    example: 'University of Oxford',
  })
  @IsOptional()
  @IsString()
  institution?: string;

  @ApiPropertyOptional({
    description: 'Department or research group',
    example: 'Department of Computer Science',
  })
  @IsOptional()
  @IsString()
  department?: string;

  @ApiPropertyOptional({
    description: 'Academic title / degree',
    example: 'Ph.D., Associate Professor',
  })
  @IsOptional()
  @IsString()
  academicTitle?: string;

  @ApiPropertyOptional({
    description: 'ORCID Identifier',
    example: '0000-0002-1825-0097',
  })
  @IsOptional()
  @IsString()
  orcidId?: string;

  @ApiPropertyOptional({
    description: 'Personal or lab website URL',
    example: 'https://lab.flux.ac.uk',
  })
  @IsOptional()
  @IsString()
  website?: string;
}
