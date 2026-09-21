import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Res,
  Header,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CompilerService } from './compiler.service';
import {
  CompileLatexDto,
  SyncIncrementalDto,
  WordCountDto,
  SaveAndSyncDto,
  CompileDocumentDto,
} from './dto/compiler.dto';
import { ForwardSyncDto, ReverseSyncDto } from './dto/synctex.dto';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Document - Compiler')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class CompilerController {
  constructor(private readonly compilerService: CompilerService) {}

  @Post(['compiler/compile', 'latex/compile'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Compile LaTeX or manuscript source to PDF via compiler service',
  })
  async compile(
    @Body() dto: CompileLatexDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.compilerService.compile(dto, userId);
  }

  @Post([
    'pages/:pageId/sync-project',
    'page/:pageId/sync-project',
    'projects/:projectId/pages/:pageId/sync-project',
    'compiler/sync-project/:pageId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sync all page files to compiler workspace' })
  async syncProject(@Param('pageId') pageId: string) {
    return this.compilerService.syncProject(pageId);
  }

  @Post([
    'pages/:pageId/sync-incremental',
    'page/:pageId/sync-incremental',
    'projects/:projectId/pages/:pageId/sync-incremental',
    'compiler/sync-incremental/:pageId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Incrementally sync only dirty/changed files to compiler',
  })
  async syncIncremental(
    @Param('pageId') pageId: string,
    @Body() dto: SyncIncrementalDto,
  ) {
    return this.compilerService.syncIncremental(pageId, dto);
  }

  @Post([
    'documents/pages/:pageId/save-and-sync',
    'manuscript/pages/:pageId/save-and-sync',
    'pages/:pageId/save-and-sync',
    'compiler/save-and-sync/:pageId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Save page content with debounced auto-versioning and LaTeX compiler tree sync',
  })
  async saveAndSync(
    @Param('pageId') pageId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: SaveAndSyncDto,
  ) {
    return this.compilerService.saveAndSync(pageId, userId, dto);
  }

  @Post([
    'documents/pages/:pageId/build',
    'manuscript/pages/:pageId/build',
    'pages/:pageId/build',
    'compiler/build/:pageId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Assemble full multi-section document and compile to PDF with SyncTeX mapping',
  })
  async buildDocument(
    @Param('pageId') pageId: string,
    @Body() dto: CompileDocumentDto,
  ) {
    return this.compilerService.buildDocument(pageId, dto);
  }

  @Post([
    'documents/pages/:pageId/rollback/:versionId',
    'manuscript/pages/:pageId/rollback/:versionId',
    'pages/:pageId/rollback/:versionId',
    'compiler/rollback/:pageId/:versionId',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Rollback page to a previous version snapshot and trigger compiler resync',
  })
  async rollbackAndSync(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.compilerService.rollbackAndSync(pageId, versionId);
  }

  @Post(['compiler/word-count', 'latex/word-count'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Calculate academic word count and metrics (texcount parity)',
  })
  async wordCount(@Body() dto: WordCountDto) {
    return this.compilerService.getWordCount(dto.source);
  }

  @Post([
    'synctex/forward',
    'projects/:projectId/synctex/forward',
    'compiler/synctex/forward',
    'compiler/projects/:projectId/synctex/forward',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Forward SyncTeX: map LaTeX source line/column to PDF page coordinates',
  })
  async forwardSync(@Body() dto: ForwardSyncDto) {
    return this.compilerService.forwardSync(dto);
  }

  @Post([
    'synctex/reverse',
    'projects/:projectId/synctex/reverse',
    'compiler/synctex/reverse',
    'compiler/projects/:projectId/synctex/reverse',
  ])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Reverse SyncTeX: map clicked PDF page coordinates to LaTeX source line/column',
  })
  async reverseSync(@Body() dto: ReverseSyncDto) {
    return this.compilerService.reverseSync(dto);
  }
  @Get(':projectId/compiler/artifacts')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List auxiliary files generated by LaTeX compilation' })
  async listAuxFiles(@Param('projectId') projectId: string) {
    return this.compilerService.listAuxFiles(projectId);
  }

  @Get(':projectId/compiler/artifacts/:filename')
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Download a specific auxiliary file' })
  @Header('Content-Type', 'text/plain')
  async downloadAuxFile(
    @Param('projectId') projectId: string,
    @Param('filename') filename: string,
    @Res() res: any,
  ) {
    return this.compilerService.downloadAuxFile(projectId, filename, res);
  }
}

export const LatexController = CompilerController;
export type LatexController = CompilerController;
export const EngineController = CompilerController;
export type EngineController = CompilerController;
