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
import { ManuscriptEngineService } from './manuscript-engine.service';
import {
  SaveAndSyncDto,
  CompileManuscriptDto,
} from './dto/manuscript-engine.dto';
import { JwtAuthGuard } from '@/core/guards/jwt-auth.guard';
import { CurrentUser } from '@/core/decorators/current-user.decorator';

@ApiTags('Manuscript - Engine')
@ApiBearerAuth('JWT-auth')
@Controller('api/manuscript')
@UseGuards(JwtAuthGuard)
export class ManuscriptEngineController {
  constructor(private readonly engineService: ManuscriptEngineService) {}

  @Post('pages/:pageId/save-and-sync')
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
    return this.engineService.saveAndSync(pageId, userId, dto);
  }

  @Post('pages/:pageId/build')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Assemble full multi-section manuscript and compile to PDF with SyncTeX mapping',
  })
  async buildManuscript(
    @Param('pageId') pageId: string,
    @Body() dto: CompileManuscriptDto,
  ) {
    return this.engineService.buildManuscript(pageId, dto);
  }

  @Post('pages/:pageId/rollback/:versionId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Rollback page to a previous version snapshot and trigger compiler resync',
  })
  async rollbackAndSync(
    @Param('pageId') pageId: string,
    @Param('versionId') versionId: string,
  ) {
    return this.engineService.rollbackAndSync(pageId, versionId);
  }
}
