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
} from '@nestjs/common';
import { DocumentUpdaterService } from './document-updater.service';
import { QueueUpdateDto } from './dto/queue-update.dto';
import { FlushProjectDto } from './dto/flush-project.dto';
import { FlushResultDto } from './dto/flush-result.dto';
import { InFlightDocStateDto } from './dto/in-flight-doc-state.dto';
import { DocUpdaterConflictException } from './core/domain/exceptions/doc-updater-conflict.exception';
import { InFlightNotFoundException } from './core/domain/exceptions/in-flight-not-found.exception';
import { DocumentLockedException } from './core/domain/exceptions/document-locked.exception';

@Controller('project/:projectId')
export class DocumentUpdaterController {
  constructor(private readonly service: DocumentUpdaterService) {}

  /**
   * Queue real-time updates for a document (keystrokes / lines / splice).
   */
  @Post('doc/:docId/update')
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
  @HttpCode(HttpStatus.OK)
  public async flushDoc(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
  ) {
    try {
      return await this.service.flushDoc(projectId, docId);
    } catch (err) {
      if (err instanceof DocumentLockedException || err instanceof DocUpdaterConflictException) {
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
  @HttpCode(HttpStatus.NO_CONTENT)
  public async evictDoc(
    @Param('projectId') projectId: string,
    @Param('docId') docId: string,
  ): Promise<void> {
    await this.service.evictDoc(projectId, docId);
  }
}
