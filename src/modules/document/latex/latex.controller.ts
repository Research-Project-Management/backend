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

  @Post('pages/:pageId/sync-project')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Sync all page files to LaTeX project' })
  async syncProject(@Param('pageId') pageId: string) {
    return this.latexService.syncProject(pageId);
  }

  @Post('pages/:pageId/sync-incremental')
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
