import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { TemplatesService } from './templates.service';
import {
  QueryTemplatesDto,
  SearchTemplatesDto,
  InstantiateTemplateDto,
  OverleafInstantiateTemplateDto,
  CreateTemplateDto,
} from './dto/template.dto';

@ApiTags('Manuscripts - Templates')
@Controller(['api/v1/manuscripts/templates', 'manuscripts/templates', 'templates'])
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  private extractUserId(req: any): string {
    return req?.user?.id || req?.headers?.['x-user-id'] || 'anonymous-user';
  }

  @Get()
  @ApiOperation({ summary: 'List available manuscript starter templates' })
  @ApiResponse({ status: 200, description: 'Paginated list of templates' })
  async listTemplates(@Query() query: QueryTemplatesDto) {
    return this.templatesService.listTemplates(query);
  }

  @Get('search')
  @ApiOperation({ summary: 'Search manuscript templates by keyword or tag' })
  @ApiResponse({ status: 200, description: 'Search results' })
  async searchTemplates(@Query() query: SearchTemplatesDto) {
    return this.templatesService.searchTemplates(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get details and files of a manuscript template' })
  @ApiResponse({ status: 200, description: 'Template detail' })
  async getTemplate(@Param('id') id: string) {
    return this.templatesService.getTemplate(id);
  }

  @Post('instantiate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new project instantiated from a template' })
  @ApiResponse({ status: 201, description: 'Project successfully created from template' })
  async instantiateTemplate(
    @Req() req: any,
    @Body() dto: InstantiateTemplateDto,
  ) {
    const userId = this.extractUserId(req);
    return this.templatesService.instantiateTemplate(userId, dto);
  }

  @Post('custom')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Publish or create a custom manuscript template' })
  @ApiResponse({ status: 201, description: 'Custom template created' })
  async createCustomTemplate(@Body() dto: CreateTemplateDto) {
    return this.templatesService.createCustomTemplate(dto);
  }
}

@ApiTags('Manuscripts - Overleaf Parity')
@Controller('project')
export class OverleafTemplatesParityController {
  constructor(private readonly templatesService: TemplatesService) {}

  private extractUserId(req: any): string {
    return req?.user?.id || req?.headers?.['x-user-id'] || 'anonymous-user';
  }

  @Post('new/template')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Overleaf 1:1 API Parity: Instantiate project from template' })
  @ApiResponse({ status: 201, description: 'Created project object with project_id' })
  async instantiateOverleaf(
    @Req() req: any,
    @Body() dto: OverleafInstantiateTemplateDto,
  ) {
    const userId = this.extractUserId(req);
    const templateId = dto.template_id || dto.templateVersionId || '';
    const projectName = dto.project_name || dto.projectName;

    const result = await this.templatesService.instantiateTemplate(userId, {
      templateId,
      projectName,
    });

    return {
      project_id: result.projectId,
      project: {
        _id: result.projectId,
        name: result.projectName,
        owner_ref: result.ownerId,
        rootDoc_id: result.mainFile,
        compiler: result.compiler,
        fromTemplateId: result.fromTemplateId,
        fromTemplateVersionId: result.fromTemplateVersionId,
        files: result.files,
      },
    };
  }
}
