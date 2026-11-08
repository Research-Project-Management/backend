import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { StickyService } from './sticky.service';
import {
  CreateStickyDto,
  UpdateStickyDto,
  ReorderStickiesDto,
  GetStickiesQueryDto,
  StickyListResponseDto,
  SingleStickyResponseDto,
  DeleteStickyResponseDto,
  ReorderStickiesResponseDto,
} from './dto/sticky.dto';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { CurrentUser } from '@/modules/identity/auth';

/**
 * Sticky Notes Controller
 *
 * International RESTful Standard API for managing personal sticky notes:
 * - Resource Collection: /api/v1/stickies
 * - Single Resource: /api/v1/stickies/:stickyId
 * - Actions: /api/v1/stickies/reorder
 * - Methods: GET, POST, PATCH, DELETE, PUT (reorder)
 * - Strict UUID v4 parameter validation via ParseUUIDPipe
 * - Comprehensive OpenAPI 3.0 annotations
 */
@ApiTags('Sticky Notes')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/stickies')
@UseGuards(JwtAuthGuard)
export class StickyController {
  constructor(private readonly stickyService: StickyService) {}

  @Get()
  @ApiOperation({
    summary: 'List personal stickies',
    description:
      'Retrieve all personal sticky notes belonging to the authenticated user, ordered by board sort order.',
  })
  @ApiOkResponse({
    description: 'List of personal stickies retrieved successfully',
    type: StickyListResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  async getStickies(
    @CurrentUser('id') userId: string,
    @Query() query: GetStickiesQueryDto,
  ) {
    return this.stickyService.getStickies(userId, query.search);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create personal sticky',
    description:
      'Create a new personal sticky note with automated color cycling and HTML sanitization.',
  })
  @ApiCreatedResponse({
    description: 'Sticky note created successfully',
    type: SingleStickyResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid input payload' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiUnprocessableEntityResponse({
    description:
      'Cannot create a new sticky note when the latest draft is still blank',
  })
  async createSticky(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateStickyDto,
  ) {
    return this.stickyService.createSticky(userId, dto);
  }

  @Put('reorder')
  @ApiOperation({
    summary: 'Reorder stickies',
    description:
      'Batch update sort order indices for an array of sticky notes.',
  })
  @ApiOkResponse({
    description: 'Stickies reordered successfully',
    type: ReorderStickiesResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid sticky IDs array or UUID format',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({
    description: 'One or more stickies belong to another user',
  })
  async reorderStickies(
    @CurrentUser('id') userId: string,
    @Body() dto: ReorderStickiesDto,
  ) {
    return this.stickyService.reorderStickies(dto.stickyIds, userId);
  }

  @Get(':stickyId')
  @ApiOperation({
    summary: 'Get single sticky note by ID',
    description:
      'Retrieve details of a specific sticky note belonging to the authenticated user.',
  })
  @ApiParam({
    name: 'stickyId',
    description: 'UUID v7 of the sticky note',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Sticky note retrieved successfully',
    type: SingleStickyResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid UUID v7 format' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Sticky belongs to another user' })
  @ApiNotFoundResponse({ description: 'Sticky not found' })
  async getStickyById(
    @Param('stickyId', new ParseUUIDPipe({ version: '7' })) stickyId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.stickyService.getStickyById(stickyId, userId);
  }

  @Patch(':stickyId')
  @ApiOperation({
    summary: 'Update sticky note',
    description:
      'Partially update title, content, color, or canvas position of a sticky note.',
  })
  @ApiParam({
    name: 'stickyId',
    description: 'UUID v7 of the sticky note',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Sticky note updated successfully',
    type: SingleStickyResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Invalid UUID v7 format or update payload',
  })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Sticky belongs to another user' })
  @ApiNotFoundResponse({ description: 'Sticky not found' })
  async updateSticky(
    @Param('stickyId', new ParseUUIDPipe({ version: '7' })) stickyId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateStickyDto,
  ) {
    return this.stickyService.updateSticky(stickyId, userId, dto);
  }

  @Delete(':stickyId')
  @ApiOperation({
    summary: 'Delete sticky note',
    description:
      'Permanently delete a personal sticky note belonging to the authenticated user.',
  })
  @ApiParam({
    name: 'stickyId',
    description: 'UUID v7 of the sticky note',
    format: 'uuid',
  })
  @ApiOkResponse({
    description: 'Sticky note deleted successfully',
    type: DeleteStickyResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Invalid UUID v7 format' })
  @ApiUnauthorizedResponse({ description: 'Authentication required' })
  @ApiForbiddenResponse({ description: 'Sticky belongs to another user' })
  @ApiNotFoundResponse({ description: 'Sticky not found' })
  async deleteSticky(
    @Param('stickyId', new ParseUUIDPipe({ version: '7' })) stickyId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.stickyService.deleteSticky(stickyId, userId);
  }
}
