/**
 * diagnostics/diagnostics.controller.ts
 * REST Controller exposing Diagnostics, Log Parsing, Linting, and Explanations.
 */

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';
import { DiagnosticsService } from './diagnostics.service';
import {
  ParseLogDto,
  LintDocumentDto,
  DiagnosticReportDto,
  ErrorExplanationDto,
  AutoFixRequestDto,
  AutoFixResponseDto,
} from './dto/diagnostics.dto';
import { InvalidLogFormatException } from './core/domain/exceptions/invalid-log-format.exception';
import { ExplanationNotFoundException } from './core/domain/exceptions/explanation-not-found.exception';

@ApiTags('Manuscripts Diagnostics')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/manuscripts/diagnostics',
  'api/v1/manuscripts/projects',
  'projects',
])
@UseGuards(JwtAuthGuard)
export class DiagnosticsController {
  constructor(private readonly diagnosticsService: DiagnosticsService) {}

  @Post('parse-log')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Parse a raw TeX compilation log into structured diagnostics',
  })
  @ApiResponse({ status: 200, type: DiagnosticReportDto })
  @ApiResponse({ status: 400, description: 'Empty or invalid log text' })
  public parseLog(@Body() dto: ParseLogDto): DiagnosticReportDto {
    try {
      return this.diagnosticsService.parseCompileLog(dto);
    } catch (err) {
      if (err instanceof InvalidLogFormatException) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  @Post('lint')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Statically check LaTeX document syntax before compilation',
  })
  @ApiResponse({ status: 200, type: DiagnosticReportDto })
  public lintDocument(@Body() dto: LintDocumentDto): DiagnosticReportDto {
    return this.diagnosticsService.lintDocument(dto);
  }

  @Post([':projectId/lint', 'project/:projectId/lint'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Statically check LaTeX document syntax and citations for an entire project',
  })
  @ApiResponse({ status: 200, type: DiagnosticReportDto })
  public async lintProject(
    @Param('projectId') projectId: string,
  ): Promise<DiagnosticReportDto> {
    return await this.diagnosticsService.lintProject(projectId);
  }

  @Post(['autofix', ':projectId/autofix'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Automatically repair common LaTeX syntax errors (smart quotes, naked _, %)',
  })
  @ApiResponse({ status: 200, type: AutoFixResponseDto })
  public autoFixDocument(@Body() dto: AutoFixRequestDto): AutoFixResponseDto {
    return this.diagnosticsService.autoFix(dto.source);
  }

  @Get('explain/:code')
  @ApiOperation({
    summary: 'Retrieve detailed explanation and remedy for an error code',
  })
  @ApiResponse({ status: 200, type: ErrorExplanationDto })
  @ApiResponse({
    status: 404,
    description: 'Explanation code not found in knowledge base',
  })
  public getExplanation(@Param('code') code: string): ErrorExplanationDto {
    try {
      return this.diagnosticsService.getErrorExplanation(code);
    } catch (err) {
      if (err instanceof ExplanationNotFoundException) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }
  }

  @Get('rules')
  @ApiOperation({ summary: 'List all diagnostic and error explanation rules' })
  @ApiResponse({ status: 200, type: [ErrorExplanationDto] })
  public listAllRules(): ErrorExplanationDto[] {
    return this.diagnosticsService.listAllRules();
  }
}
