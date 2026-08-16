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
import { EngineService } from './engine.service';
import { SaveAndSyncDto, CompileDocumentDto } from './dto/engine.dto';
import { JwtAuthGuard } from '@/modules/iam/authentication';
import { CurrentUser } from '@/modules/iam/authentication';

@ApiTags('Document - Engine')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class EngineController {
  constructor(private readonly engineService: EngineService) {}

  @Post([
    'documents/pages/:pageId/save-and-sync',
    'manuscript/pages/:pageId/save-and-sync',
  ])
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

  @Post(['documents/pages/:pageId/build', 'manuscript/pages/:pageId/build'])
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Assemble full multi-section document and compile to PDF with SyncTeX mapping',
  })
  async buildDocument(
    @Param('pageId') pageId: string,
    @Body() dto: CompileDocumentDto,
  ) {
    return this.engineService.buildDocument(pageId, dto);
  }

  @Post([
    'documents/pages/:pageId/rollback/:versionId',
    'manuscript/pages/:pageId/rollback/:versionId',
  ])
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
