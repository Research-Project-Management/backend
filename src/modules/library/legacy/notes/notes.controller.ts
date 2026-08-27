import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { NotesService } from './notes.service';
import { CreateNoteDto, UpdateNoteDto } from './dto/notes.dto';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { WorkspaceRoleGuard } from '@/modules/iam/authz/guards/workspace-role.guard';
import { WorkspaceRoles } from '@/modules/iam/authz/decorators/workspace-roles.decorator';

@ApiTags('Library - Notes')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, WorkspaceRoleGuard)
@Controller('workspace/:workspaceId/library/notes')
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Get()
  @WorkspaceRoles('admin', 'member', 'viewer')
  @ApiOperation({ summary: 'Get all standalone or catalog notes in workspace' })
  async getNotes(
    @Param('workspaceId') workspaceId: string,
    @Query('itemId') itemId?: string,
  ) {
    const notes = await this.notesService.getNotes(workspaceId, itemId);
    return { data: notes, total: notes.length };
  }

  @Post()
  @WorkspaceRoles('admin', 'member')
  @ApiOperation({
    summary: 'Create a new standalone note or child note on catalog item',
  })
  async createNote(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateNoteDto,
  ) {
    const note = await this.notesService.createNote(workspaceId, dto, userId);
    return { data: note };
  }

  @Put(':noteId')
  @WorkspaceRoles('admin', 'member')
  @ApiOperation({ summary: 'Update note content or tags' })
  async updateNote(
    @Param('workspaceId') workspaceId: string,
    @Param('noteId') noteId: string,
    @Body() dto: UpdateNoteDto,
  ) {
    const note = await this.notesService.updateNote(workspaceId, noteId, dto);
    return { data: note };
  }

  @Delete(':noteId')
  @WorkspaceRoles('admin', 'member')
  @ApiOperation({ summary: 'Delete a note' })
  async deleteNote(
    @Param('workspaceId') workspaceId: string,
    @Param('noteId') noteId: string,
  ) {
    await this.notesService.deleteNote(workspaceId, noteId);
    return { deleted: true };
  }
}
