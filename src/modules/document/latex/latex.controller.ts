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
import { LatexService } from './latex.service';
import { CompileLatexDto, SyncIncrementalDto } from './dto/latex.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { ProjectRoleGuard } from '@/modules/iam/authz/guards/project-role.guard';
import { ProjectRoles } from '@/modules/iam/authz/decorators/project-roles.decorator';

@ApiTags('Manuscript')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class LatexController {
  constructor(private readonly latexService: LatexService) {}

  @Post('latex/compile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Compile LaTeX source to PDF via LaTeX service' })
  async compile(@Body() dto: CompileLatexDto) {
    return this.latexService.compile(dto);
  }

  @Post(['pages/:pageId/sync-project', 'page/:pageId/sync-project'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sync all page files to LaTeX project' })
  async syncProject(@Param('pageId') pageId: string) {
    return this.latexService.syncProject(pageId);
  }

  @Post(['pages/:pageId/sync-incremental', 'page/:pageId/sync-incremental'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('admin', 'contributor')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Incrementally sync only dirty/changed files to LaTeX',
  })
  async syncIncremental(
    @Param('pageId') pageId: string,
    @Body() dto: SyncIncrementalDto,
  ) {
    return this.latexService.syncIncremental(pageId, dto);
  }
}
