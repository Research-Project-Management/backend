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
  @ApiProperty({ description: 'Target Project UUID' })
  @IsString()
  @IsNotEmpty()
  projectId!: string;

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
  @ApiProperty({ description: 'Target Project UUID' })
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @ApiPropertyOptional({
    description: 'Commit message',
    default: 'Update manuscript from Flux LaTeX Platform',
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
  @ApiProperty({ description: 'Target Project UUID' })
  @IsString()
  @IsNotEmpty()
  projectId!: string;

  @ApiPropertyOptional({ description: 'Target branch', default: 'main' })
  @IsString()
  @IsOptional()
  branch?: string;
}

export class ImportGithubRepoDto {
  @ApiProperty({ description: 'Target Project UUID' })
  @IsString()
  @IsNotEmpty()
  projectId!: string;

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
