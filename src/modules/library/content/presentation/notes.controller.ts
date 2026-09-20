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
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
import { NotesService } from '../application/services/notes.service';
import { JwtAuthGuard } from '../../../iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../iam/authn/decorators/user.decorator';
import { ProjectRoleGuard } from '../../../iam/authz/guards/role.guard';
import { ProjectRoles } from '../../../iam/authz/decorators/role.decorator';

import { CreateNoteDto, UpdateNoteDto } from '../application/dtos/notes.dto';

@ApiTags('Library Notes')
@ApiBearerAuth('JWT-auth')
@Controller([
  'api/v1/library/notes',
  'api/v1/projects/:projectId/library/notes',
])
@UseGuards(JwtAuthGuard, ProjectRoleGuard)
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Get()
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List library notes for user or project' })
  async listNotes(
    @CurrentUser('id') currentUserId: string,
    @Query('itemId') itemId?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const rawProjectId = paramProjectId || queryProjectId;
    const effectiveProjectId =
      rawProjectId &&
      rawProjectId !== 'me' &&
      rawProjectId !== 'user' &&
      rawProjectId !== 'personal' &&
      isUUID(rawProjectId)
        ? rawProjectId
        : undefined;
    return this.notesService.listNotes(
      currentUserId,
      itemId,
      effectiveProjectId,
    );
  }

  @Get(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'Get a library note by ID' })
  async getNote(
    @CurrentUser('id') currentUserId: string,
    @Param('id') id: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    const note = await this.notesService.getNote(
      currentUserId,
      id,
      effectiveProjectId,
    );
    if (!note) {
      throw new NotFoundException(`Note ${id} not found`);
    }

    return note;
  }

  @Post()
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Create a note in user or project library' })
  async createNote(
    @CurrentUser('id') currentUserId: string,
    @Body() body: CreateNoteDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId =
      paramProjectId || queryProjectId || body.projectId;
    return this.notesService.createNote(currentUserId, {
      ...body,
      projectId: effectiveProjectId || undefined,
      createdById: currentUserId || 'system',
    });
  }

  @Get('items/:itemId')
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({ summary: 'List notes for an item' })
  async listNotesByItem(
    @CurrentUser('id') currentUserId: string,
    @Param('itemId') itemId: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    return this.notesService.listNotes(
      currentUserId,
      itemId,
      effectiveProjectId,
    );
  }

  @Post('items/:itemId/from-annotations')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Extract notes from annotations' })
  async extractNotesFromAnnotations(
    @CurrentUser('id') currentUserId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.notesService.extractNotesFromAnnotations(currentUserId, itemId);
  }

  @Patch(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Update a note' })
  async updateNote(
    @CurrentUser('id') currentUserId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() body: UpdateNoteDto,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    const expectedVersion =
      body.expectedVersion ??
      (ifMatch ? parseInt(ifMatch.replace(/["']/g, ''), 10) : undefined);
    if (expectedVersion === undefined || isNaN(expectedVersion)) {
      throw new BadRequestException(
        'Optimistic locking requirement: expectedVersion or If-Match header is required',
      );
    }

    const { expectedVersion: _, ...updateData } = body;
    return this.notesService.updateNote(
      currentUserId,
      id,
      expectedVersion,
      updateData,
      effectiveProjectId,
    );
  }

  @Delete(':id')
  @ProjectRoles('owner', 'coordinator', 'contributor')
  @ApiOperation({ summary: 'Delete a note' })
  async deleteNote(
    @CurrentUser('id') currentUserId: string,
    @Param('id') id: string,
    @Query('expectedVersion') expectedVersionQuery?: string,
    @Headers('if-match') ifMatch?: string,
    @Query('projectId') queryProjectId?: string,
    @Param('projectId') paramProjectId?: string,
  ) {
    const effectiveProjectId = paramProjectId || queryProjectId;
    const expectedVersion =
      expectedVersionQuery !== undefined
        ? parseInt(expectedVersionQuery, 10)
        : ifMatch
          ? parseInt(ifMatch.replace(/["']/g, ''), 10)
          : undefined;
    const deleted = await this.notesService.deleteNote(
      currentUserId,
      id,
      expectedVersion,
      effectiveProjectId,
    );
    if (!deleted) {
      throw new NotFoundException(`Note ${id} not found`);
    }

    return { deleted, id };
  }
}
