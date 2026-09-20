import {
  Controller,
  Post,
  Body,
  Param,
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
import { JwtAuthGuard } from '@/modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/role.decorator';

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
}

export const LatexController = CompilerController;
export type LatexController = CompilerController;
export const EngineController = CompilerController;
export type EngineController = CompilerController;
