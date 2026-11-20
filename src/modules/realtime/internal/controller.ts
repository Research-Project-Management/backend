import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { LiveCollaborationPort } from '@/modules/pages/core/ports/live-collaboration.port';
import { REALTIME_NAMESPACES } from '../core/config';
import { RealtimeFacade } from '../realtime.facade';
import { RealtimeInternalAuthGuard } from './auth';
import {
  ApplyExternalTextInternalDto,
  EvictDocInternalDto,
  FlushDocsInternalDto,
  PresenceQueryInternalDto,
} from './dto';

@Controller()
export class RealtimeControlController {
  constructor(
    private readonly liveCollab: LiveCollaborationPort,
    private readonly facade: RealtimeFacade,
  ) {}

  @Get()
  public getStatus() {
    return {
      ...this.facade.getStats(),
      service: 'flux-realtime',
      namespaces: Object.values(REALTIME_NAMESPACES),
    };
  }

  @UseGuards(RealtimeInternalAuthGuard)
  @Post('internal/realtime/flush')
  @HttpCode(HttpStatus.OK)
  public async flushDocs(@Body() dto: FlushDocsInternalDto) {
    const flushedDocIds = await this.liveCollab.flushDocs(
      dto.projectId,
      dto.docIds ?? [],
    );
    return { flushedDocIds };
  }

  @UseGuards(RealtimeInternalAuthGuard)
  @Post('internal/realtime/apply-text')
  @HttpCode(HttpStatus.OK)
  public async applyExternalText(@Body() dto: ApplyExternalTextInternalDto) {
    const active = await this.liveCollab.applyExternalText(
      dto.projectId,
      dto.docId,
      dto.text,
    );
    return { active };
  }

  @UseGuards(RealtimeInternalAuthGuard)
  @Post('internal/realtime/evict-doc')
  @HttpCode(HttpStatus.OK)
  public async evictDoc(@Body() dto: EvictDocInternalDto) {
    await this.liveCollab.evictDoc(dto.projectId, dto.docId);
    return { evicted: true };
  }

  @UseGuards(RealtimeInternalAuthGuard)
  @Get('internal/realtime/presence')
  public async getPresence(@Query() query: PresenceQueryInternalDto) {
    const docId = query.docId?.trim() || null;
    const users = await this.liveCollab.getPresence(query.projectId, docId);
    return { users };
  }
}
