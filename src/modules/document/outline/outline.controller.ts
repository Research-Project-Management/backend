import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { OutlineService } from './outline.service';
import { ExtractOutlineDto } from './dto/outline.dto';
import { JwtAuthGuard } from '@/modules/identity/auth';
import { ProjectRoleGuard, ProjectRoles } from '@/modules/project/access';

@ApiTags('Document - Outline')
@ApiBearerAuth('JWT-auth')
@Controller('api')
@UseGuards(JwtAuthGuard)
export class OutlineController {
  constructor(private readonly outlineService: OutlineService) {}

  @Get(['pages/:pageId/outline', 'projects/:projectId/pages/:pageId/outline'])
  @UseGuards(ProjectRoleGuard)
  @ProjectRoles('owner', 'coordinator', 'contributor', 'reviewer')
  @ApiOperation({
    summary:
      'Extract structured heading outline / TOC tree from a document and its child sections',
  })
  async getDocumentOutline(@Param('pageId') pageId: string) {
    return this.outlineService.getDocumentOutline(pageId);
  }

  @Post('compiler/outline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Parse heading outline on-the-fly from provided text source buffer',
  })
  parseRawOutline(@Body() dto: ExtractOutlineDto) {
    const entries = this.outlineService.parseOutlineFromSource(
      dto.source || '',
      'buffer.tex',
    );
    const tree = this.outlineService.buildNestedOutlineTree(entries);
    return {
      entries,
      tree,
      totalHeadings: entries.length,
    };
  }
}
