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
import { NotesService } from './notes.service';
import { JwtAuthGuard } from '../../../modules/iam/authn/guards/auth.guard';
import { CurrentUser } from '../../../modules/iam/authn/decorators/user.decorator';

import { CreateNoteDto, UpdateNoteDto } from './dto/notes.dto';

@ApiTags('Library Notes')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/library/notes')
@UseGuards(JwtAuthGuard)
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Get()
  @ApiOperation({ summary: 'List library notes for user' })
  async listNotes(
    @CurrentUser('id') currentUserId: string,
    @Query('itemId') itemId?: string,
  ) {
    return this.notesService.listNotes(currentUserId, itemId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a library note by ID' })
  async getNote(
    @CurrentUser('id') currentUserId: string,
    @Param('id') id: string,
  ) {
    const note = await this.notesService.getNote(currentUserId, id);
    if (!note) {
      throw new NotFoundException(`Note ${id} not found`);
    }

    return note;
  }

  @Post()
  @ApiOperation({ summary: 'Create a note in user library' })
  async createNote(
    @CurrentUser('id') currentUserId: string,
    @Body() body: CreateNoteDto,
  ) {
    return this.notesService.createNote(currentUserId, {
      ...body,
      createdById: currentUserId || 'system',
    });
  }

  @Get('items/:itemId')
  @ApiOperation({ summary: 'List notes for an item' })
  async listNotesByItem(
    @CurrentUser('id') currentUserId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.notesService.listNotes(currentUserId, itemId);
  }

  @Post('items/:itemId/from-annotations')
  @ApiOperation({ summary: 'Extract notes from annotations' })
  async extractNotesFromAnnotations(
    @CurrentUser('id') currentUserId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.notesService.extractNotesFromAnnotations(
      currentUserId,
      itemId,
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a note' })
  async updateNote(
    @CurrentUser('id') currentUserId: string,
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
    return this.notesService.updateNote(
      currentUserId,
      id,
      expectedVersion,
      updateData,
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a note' })
  async deleteNote(
    @CurrentUser('id') currentUserId: string,
    @Param('id') id: string,
    @Query('expectedVersion') expectedVersionQuery?: string,
    @Headers('if-match') ifMatch?: string,
  ) {
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
    );
    if (!deleted) {
      throw new NotFoundException(`Note ${id} not found`);
    }

    return { deleted, id };
  }
}
