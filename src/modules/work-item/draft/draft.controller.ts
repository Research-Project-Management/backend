import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/iam/authn/guards/jwt-auth.guard';
import { CurrentUser } from '@/modules/iam/authn/decorators/current-user.decorator';
import { DraftService } from './draft.service';
import { CreateDraftDto } from './dto/create-draft.dto';
import { UpdateDraftDto } from './dto/update-draft.dto';
import { PublishDraftDto } from './dto/publish-draft.dto';
import { QueryDraftDto } from './dto/query-draft.dto';

@ApiTags('work-items')
@ApiBearerAuth('JWT-auth')
@Controller('api/work-items/drafts')
@UseGuards(JwtAuthGuard)
export class DraftController {
  constructor(private readonly draftService: DraftService) {}

  @Get()
  @ApiOperation({ summary: 'Get all draft work items for the current user (My Drafts)' })
  async getMyDrafts(
    @CurrentUser('id') userId: string,
    @Query() queryDraftDto: QueryDraftDto,
  ) {
    return this.draftService.getUserDrafts(userId, queryDraftDto);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create or auto-save a new draft work item' })
  async createDraft(
    @CurrentUser('id') userId: string,
    @Body() createDraftDto: CreateDraftDto,
  ) {
    return this.draftService.createDraft(createDraftDto, userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a specific draft by ID' })
  @ApiParam({ name: 'id', description: 'Draft UUID' })
  async getDraft(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.draftService.getDraft(id, userId);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update draft content (Auto-save debounce endpoint)' })
  @ApiParam({ name: 'id', description: 'Draft UUID' })
  async updateDraft(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() updateDraftDto: UpdateDraftDto,
  ) {
    return this.draftService.updateDraft(id, updateDraftDto, userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Patch draft content (Partial auto-save)' })
  @ApiParam({ name: 'id', description: 'Draft UUID' })
  async patchDraft(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() updateDraftDto: UpdateDraftDto,
  ) {
    return this.draftService.updateDraft(id, updateDraftDto, userId);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Publish draft into an active work item (cấp mã FLUX-123 & xóa draft)' })
  @ApiParam({ name: 'id', description: 'Draft UUID' })
  async publishDraft(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() publishDraftDto: PublishDraftDto,
  ) {
    return this.draftService.publishDraft(id, publishDraftDto, userId);
  }

  @Post(':id/duplicate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Duplicate a draft work item (Make a copy)' })
  @ApiParam({ name: 'id', description: 'Draft UUID' })
  async duplicateDraft(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.draftService.duplicateDraft(id, userId);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Discard / delete a draft work item' })
  @ApiParam({ name: 'id', description: 'Draft UUID' })
  async deleteDraft(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.draftService.deleteDraft(id, userId);
  }
}

