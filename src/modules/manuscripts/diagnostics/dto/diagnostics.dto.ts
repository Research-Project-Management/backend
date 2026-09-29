/**
 * diagnostics/dto/diagnostics.dto.ts
 * Data Transfer Objects for Diagnostics API endpoints.
 */

import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ParseLogDto {
  @ApiProperty({ description: 'Raw compilation log text to parse' })
  @IsString()
  @IsNotEmpty({ message: 'logText is required and cannot be empty' })
  logText!: string;

  @ApiPropertyOptional({
    description: 'Default filename if none detected in log',
    default: 'main.tex',
  })
  @IsString()
  @IsOptional()
  defaultFile?: string;

  @ApiPropertyOptional({
    description: 'Compiler engine (pdflatex, xelatex, tectonic)',
    default: 'pdflatex',
  })
  @IsString()
  @IsOptional()
  engine?: string;
}

export class LintDocumentDto {
  @ApiProperty({ description: 'LaTeX source content to statically lint' })
  @IsString()
  source!: string;

  @ApiPropertyOptional({
    description: 'Target filename for lint reports',
    default: 'main.tex',
  })
  @IsString()
  @IsOptional()
  filename?: string;
}

export class ErrorExplanationDto {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  explanation!: string;

  @ApiProperty({ type: [String] })
  commonCauses!: string[];

  @ApiPropertyOptional()
  suggestedFix?: string;

  @ApiPropertyOptional()
  exampleSnippet?: string;

  @ApiPropertyOptional()
  documentationUrl?: string;
}

export class DiagnosticItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  file!: string;

  @ApiPropertyOptional({ type: Number, nullable: true })
  line!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  column!: number | null;

  @ApiProperty({ enum: ['error', 'warning', 'info', 'badbox'] })
  severity!: string;

  @ApiProperty()
  message!: string;

  @ApiPropertyOptional()
  context?: string;

  @ApiPropertyOptional()
  code?: string;

  @ApiPropertyOptional({ type: () => ErrorExplanationDto })
  explanation?: ErrorExplanationDto;

  @ApiPropertyOptional()
  quickFix?: {
    description: string;
    replacementText: string;
  };
}

export class AutoFixRequestDto {
  @ApiProperty({ description: 'LaTeX source content to auto-fix' })
  @IsString()
  source!: string;

  @ApiPropertyOptional({ description: 'Target filename', default: 'main.tex' })
  @IsString()
  @IsOptional()
  filename?: string;
}

export class AppliedFixDto {
  @ApiProperty()
  line!: number;

  @ApiProperty()
  rule!: string;

  @ApiProperty()
  description!: string;
}

export class AutoFixResponseDto {
  @ApiProperty()
  isFixed!: boolean;

  @ApiProperty()
  fixedSource!: string;

  @ApiProperty({ type: [AppliedFixDto] })
  appliedFixes!: AppliedFixDto[];
}

export class DiagnosticReportDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  isSuccess!: boolean;

  @ApiProperty()
  errorsCount!: number;

  @ApiProperty()
  warningsCount!: number;

  @ApiProperty()
  badboxesCount!: number;

  @ApiProperty()
  infoCount!: number;

  @ApiProperty()
  totalCount!: number;

  @ApiProperty({ type: [DiagnosticItemDto] })
  items!: DiagnosticItemDto[];
}
