import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  Headers,
  UseGuards,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { NotesService } from './notes.service';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/jwt-auth.guard';
import { WorkspaceRoleGuard } from '../../../modules/iam/authz/guards/workspace-role.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/current-user.decorator';

import { CreateNoteDto, UpdateNoteDto } from './dto/note.dto';

@Controller([
  'api/v1/workspaces/:workspaceId/library/notes',
  'workspace/:workspaceId/library/notes',
])
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Get()
  async listNotes(
    @Param('workspaceId') workspaceId: string,
    @Query('itemId') itemId?: string,
  ) {
    const notes = await this.notesService.listNotes(workspaceId, itemId);
    return {
      success: true,
      data: notes,
    };
  }

  @Get(':id')
  async getNote(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
  ) {
    const note = await this.notesService.getNote(workspaceId, id);
    if (!note) {
      throw new NotFoundException(
        `Note ${id} not found in workspace ${workspaceId}`,
      );
    }

    return {
      success: true,
      data: note,
    };
  }

  @Post()
  async createNote(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') currentUserId: string,
    @Body() body: CreateNoteDto,
  ) {
    const note = await this.notesService.createNote(workspaceId, {
      ...body,
      createdById: currentUserId || 'system',
    });

    return {
      success: true,
      data: note,
    };
  }

  @Patch(':id')
  async updateNote(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateNoteDto,
  ) {
    const expectedVersion =
      body.expectedVersion ??
      (ifMatch ? parseInt(ifMatch.replace(/["']/g, ''), 10) : undefined);
    if (!expectedVersion || isNaN(expectedVersion)) {
      throw new BadRequestException(
        'Optimistic locking requirement: expectedVersion or If-Match header is required',
      );
    }

    const { expectedVersion: _, ...updateData } = body;
    const updated = await this.notesService.updateNote(
      workspaceId,
      id,
      expectedVersion,
      updateData,
    );

    return {
      success: true,
      data: updated,
    };
  }

  @Delete(':id')
  async deleteNote(
    @Param('workspaceId') workspaceId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch?: string,
  ) {
    const expectedVersion = ifMatch
      ? parseInt(ifMatch.replace(/["']/g, ''), 10)
      : undefined;
    const deleted = await this.notesService.deleteNote(
      workspaceId,
      id,
      expectedVersion,
    );
    if (!deleted) {
      throw new NotFoundException(
        `Note ${id} not found in workspace ${workspaceId}`,
      );
    }

    return {
      success: true,
      data: { deleted },
    };
  }
}
