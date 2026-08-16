import {
  Controller,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { LatexService } from './latex.service';
import { CompileLatexDto, SyncIncrementalDto } from './dto/latex.dto';
import { JwtAuthGuard } from '@/modules/iam/authentication';

@ApiTags('Manuscript')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class LatexController {
  constructor(private readonly latexService: LatexService) {}

  @Post('latex/compile')
  @HttpCode(HttpStatus.OK)
  async compile(@Body() dto: CompileLatexDto) {
    return this.latexService.compile(dto);
  }

  @Post('pages/:pageId/sync-project')
  @HttpCode(HttpStatus.OK)
  async syncProject(@Param('pageId') pageId: string) {
    return this.latexService.syncProject(pageId);
  }

  @Post('pages/:pageId/sync-incremental')
  @HttpCode(HttpStatus.OK)
  async syncIncremental(
    @Param('pageId') pageId: string,
    @Body() dto: SyncIncrementalDto,
  ) {
    return this.latexService.syncIncremental(pageId, dto);
  }
}
