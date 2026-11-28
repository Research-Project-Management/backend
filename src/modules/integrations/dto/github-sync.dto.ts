import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateGithubRepoDto {
  @ApiProperty({
    description: 'GitHub repository name',
    example: 'latex-manuscript',
  })
  @IsString()
  @IsNotEmpty()
  name!: string;

  @ApiPropertyOptional({
    description: 'Make repository private',
    default: true,
  })
  @IsBoolean()
  @IsOptional()
  private?: boolean;

  @ApiPropertyOptional({ description: 'Repository description' })
  @IsString()
  @IsOptional()
  description?: string;
}

export class LinkGithubRepoDto {
  @ApiProperty({ description: 'Target Page UUID' })
  @IsString()
  @IsNotEmpty()
  pageId!: string;

  @ApiProperty({
    description: 'GitHub repository full name (owner/repo)',
    example: 'octocat/paper-draft',
  })
  @IsString()
  @IsNotEmpty()
  repoFullName!: string;

  @ApiPropertyOptional({ description: 'Target branch name', default: 'main' })
  @IsString()
  @IsOptional()
  branch?: string;
}

export class PushGithubDto {
  @ApiProperty({ description: 'Target Page UUID' })
  @IsString()
  @IsNotEmpty()
  pageId!: string;

  @ApiPropertyOptional({
    description: 'Commit message',
    default: 'Update manuscript from Flux',
  })
  @IsString()
  @IsOptional()
  commitMessage?: string;

  @ApiPropertyOptional({ description: 'Target branch', default: 'main' })
  @IsString()
  @IsOptional()
  branch?: string;
}

export class PullGithubDto {
  @ApiProperty({ description: 'Target Page UUID' })
  @IsString()
  @IsNotEmpty()
  pageId!: string;

  @ApiPropertyOptional({ description: 'Target branch', default: 'main' })
  @IsString()
  @IsOptional()
  branch?: string;
}

export class ImportGithubRepoDto {
  @ApiPropertyOptional({ description: 'Target Page UUID (when importing into an existing page)' })
  @IsOptional()
  @IsString()
  pageId?: string;

  @ApiPropertyOptional({ description: 'Target Space ID (e.g. "personal" or Project UUID when creating a new page)' })
  @IsOptional()
  @IsString()
  spaceId?: string;

  @ApiPropertyOptional({ description: 'Optional custom Page title' })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({
    description: 'GitHub repository full name (owner/repo)',
    example: 'octocat/paper-draft',
  })
  @IsString()
  @IsNotEmpty()
  repoFullName!: string;

  @ApiPropertyOptional({ description: 'Target branch', default: 'main' })
  @IsString()
  @IsOptional()
  branch?: string;
}
