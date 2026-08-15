import { IsString, IsOptional, IsBoolean, IsEnum } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { LatexEngine } from '../../latex/dto/latex.dto';

export class SaveAndSyncDto {
  @ApiPropertyOptional({ description: 'Page Title' })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiPropertyOptional({ description: 'Rich text or LaTeX Content' })
  @IsOptional()
  content?: Prisma.InputJsonValue;

  @ApiPropertyOptional({
    description: 'Force creating a named version snapshot immediately',
  })
  @IsBoolean()
  @IsOptional()
  createSnapshot?: boolean;

  @ApiPropertyOptional({
    description: 'Optional change description for snapshot',
  })
  @IsString()
  @IsOptional()
  versionDescription?: string;
}

export class CompileManuscriptDto {
  @ApiPropertyOptional({
    description: 'LaTeX Engine (pdflatex, xelatex, lualatex)',
    enum: LatexEngine,
    default: LatexEngine.PDFLATEX,
  })
  @IsEnum(LatexEngine)
  @IsOptional()
  engine?: LatexEngine;

  @ApiPropertyOptional({ description: 'Custom raw LaTeX preamble or override' })
  @IsString()
  @IsOptional()
  source?: string;
}
