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
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { LabelService } from './label.service';
import { CreateLabelDto, UpdateLabelDto } from './dto/label.dto';
import { JwtAuthGuard, CurrentUser } from '@/modules/iam/authn';
import { LabelType } from '@prisma/client';

@ApiTags('Organization')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class LabelController {
  constructor(private readonly labelService: LabelService) {}

  @Get(['workspace/:workspaceId/labels', 'labels/:workspaceId'])
  @ApiOperation({ summary: 'List labels in a workspace (optionally filter by type)' })
  async getLabels(
    @Param('workspaceId') workspaceId: string,
    @Query('type') type?: LabelType,
  ) {
    return this.labelService.getLabels(workspaceId, type);
  }

  @Post(['workspace/:workspaceId/labels', 'labels/:workspaceId'])
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new label in a workspace' })
  async createLabel(
    @Param('workspaceId') workspaceId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateLabelDto,
  ) {
    return this.labelService.createLabel(workspaceId, userId, dto);
  }

  @Put('labels/:labelId')
  @ApiOperation({ summary: 'Update a label name or color' })
  async updateLabel(
    @Param('labelId') labelId: string,
    @Body() dto: UpdateLabelDto,
  ) {
    return this.labelService.updateLabel(labelId, dto);
  }

  @Delete('labels/:labelId')
  @ApiOperation({ summary: 'Delete a label' })
  async deleteLabel(@Param('labelId') labelId: string) {
    return this.labelService.deleteLabel(labelId);
  }
}
