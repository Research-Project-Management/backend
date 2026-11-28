import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, CurrentUser } from '@/modules/identity/auth';
import { ProjectChannelService } from '../services/project-channel.service';
import { CreateProjectChannelDto } from '../dto/create-project-channel.dto';

@ApiTags('Chat')
@ApiBearerAuth('JWT-auth')
@Controller(['projects/:projectId', 'api/projects/:projectId'])
@UseGuards(JwtAuthGuard)
export class ProjectChatController {
  constructor(private readonly projectChannelService: ProjectChannelService) {}

  @Post('chat/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Enable project chat for the project (creates default #general channel and auto-enrolls members)',
  })
  async enableProjectChat(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectChannelService.enableProjectChat(projectId, userId);
  }

  @Get('channels')
  @ApiOperation({
    summary: 'List all chat channels belonging to the specified project',
  })
  async listChannels(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectChannelService.listProjectChannels(projectId, userId);
  }

  @Post('channels')
  @ApiOperation({
    summary:
      'Create a new custom channel in the project (Owner / Coordinator only)',
  })
  async createChannel(
    @Param('projectId') projectId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateProjectChannelDto,
  ) {
    return this.projectChannelService.createChannel(projectId, userId, dto);
  }

  @Delete('channels/:channelId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Delete a custom channel from the project (cannot delete default channel)',
  })
  async deleteChannel(
    @Param('projectId') projectId: string,
    @Param('channelId') channelId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.projectChannelService.deleteChannel(
      projectId,
      channelId,
      userId,
    );
  }
}
