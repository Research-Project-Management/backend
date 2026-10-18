/**
 * document-updater/document-updater.controller.ts
 * Inbound Driving HTTP Adapter matching Overleaf services/document-updater specifications.
 */

import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  HttpStatus,
  HttpCode,
  ConflictException,
  NotFoundException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { ProjectAccessGuard, RequireRole, Role } from '@/modules/project/access';
import { DocumentUpdaterService } from './document-updater.service';
import { QueueUpdateDto } from './dto/queue-update.dto';
import { FlushProjectDto } from './dto/flush-project.dto';
import { FlushResultDto } from './dto/flush-result.dto';
import { InFlightDocStateDto } from './dto/in-flight-doc-state.dto';
import {
  DocUpdaterConflictException,
  InFlightNotFoundException,
  DocumentLockedException,
} from './domain';

@ApiTags('Manuscripts - Document Updater')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/manuscripts/projects/:projectId/updater',
  'v1/manuscripts/projects/:projectId/updater',
  'manuscripts/projects/:projectId/updater',
  'project/:projectId',
])
@UseGuards(JwtAuthGuard, ProjectAccessGuard)
@RequireRole(Role.REVIEWER)
export class DocumentUpdaterController {
  constructor(private readonly service: DocumentUpdaterService) {}

  /**
   * Queue real-time updates for a document (keystrokes / lines / splice).
   */
  @Post('doc/:docId/update')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.ACCEPTED)
  public async queueUpdate(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
    @Body() dto: QueueUpdateDto,
  ) {
    try {
      return await this.service.queueUpdate(projectId, docId, dto);
    } catch (err) {
      if (err instanceof InFlightNotFoundException) {
        throw new NotFoundException(err.message);
      }
      if (err instanceof DocumentLockedException) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }

  /**
   * Flush-Before-Compile endpoint: flushes all dirty docs in a project into Docstore.
   */
  @Post('flush')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  public async flushProject(
    @Param('projectId') projectId: string,
    @Body() dto?: FlushProjectDto,
  ): Promise<FlushResultDto> {
    try {
      return await this.service.flushProject(projectId, dto?.force ?? false);
    } catch (err) {
      if (err instanceof DocumentLockedException) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }

  /**
   * Flush a single document into Docstore.
   */
  @Post('doc/:docId/flush')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.OK)
  public async flushDoc(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
  ) {
    try {
      return await this.service.flushDoc(projectId, docId);
    } catch (err) {
      if (
        err instanceof DocumentLockedException ||
        err instanceof DocUpdaterConflictException
      ) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }

  /**
   * Query the in-flight state of a document buffer.
   */
  @Get('doc/:docId/state')
  public async getDocState(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
  ): Promise<InFlightDocStateDto> {
    try {
      return await this.service.getDocState(projectId, docId);
    } catch (err) {
      if (err instanceof InFlightNotFoundException) {
        throw new NotFoundException(err.message);
      }
      throw err;
    }
  }

  /**
   * Evict document buffer when users disconnect.
   */
  @Delete('doc/:docId/buffer')
  @RequireRole(Role.CONTRIBUTOR)
  @HttpCode(HttpStatus.NO_CONTENT)
  public async evictDoc(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
  ): Promise<void> {
    await this.service.evictDoc(projectId, docId);
  }
}
