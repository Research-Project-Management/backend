import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '@/modules/identity/auth';
import {
  NoProjectContext,
  RequireOperator,
  OperatorGuard,
} from '@/modules/project/access';
import { AuthenticatedRequest } from '@/core';
import { TemplatesService } from './templates.service';
import { TemplateNotFoundException, InvalidTemplateException } from './domain';
import {
  QueryTemplatesDto,
  SearchTemplatesDto,
  InstantiateTemplateDto,
  CreateTemplateDto,
} from './dto/template.dto';

@ApiTags('Manuscripts - Templates')
@ApiBearerAuth('JWT-auth')
@Controller('api/v1/manuscripts/templates')
@UseGuards(JwtAuthGuard)
@NoProjectContext()
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  private extractUserId(req?: AuthenticatedRequest): string {
    const userId = req?.user?.id || req?.user?.sub || req?.user?.userId;
    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }
    return userId;
  }

  private handleError(error: unknown): never {
    if (error instanceof HttpException) {
      throw error;
    }
    if (error instanceof TemplateNotFoundException) {
      throw new NotFoundException(error.message);
    }
    if (error instanceof InvalidTemplateException) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }

  @Get()
  @NoProjectContext()
  @ApiOperation({ summary: 'List available manuscript starter templates' })
  @ApiResponse({ status: 200, description: 'Paginated list of templates' })
  async listTemplates(@Query() query: QueryTemplatesDto) {
    try {
      return await this.templatesService.listTemplates(query);
    } catch (error) {
      this.handleError(error);
    }
  }

  @Get('search')
  @NoProjectContext()
  @ApiOperation({ summary: 'Search manuscript templates by keyword or tag' })
  @ApiResponse({ status: 200, description: 'Search results' })
  async searchTemplates(@Query() query: SearchTemplatesDto) {
    try {
      return await this.templatesService.searchTemplates(query);
    } catch (error) {
      this.handleError(error);
    }
  }

  @Get(':id')
  @NoProjectContext()
  @ApiOperation({ summary: 'Get details and files of a manuscript template' })
  @ApiResponse({ status: 200, description: 'Template detail' })
  async getTemplate(@Param('id') id: string) {
    try {
      return await this.templatesService.getTemplate(id);
    } catch (error) {
      this.handleError(error);
    }
  }

  @Post('instantiate')
  @UseGuards(JwtAuthGuard)
  @NoProjectContext()
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new project instantiated from a template',
  })
  @ApiResponse({
    status: 201,
    description: 'Project successfully created from template',
  })
  async instantiateTemplate(
    @Req() req: AuthenticatedRequest,
    @Body() dto: InstantiateTemplateDto,
  ) {
    try {
      const userId = this.extractUserId(req);
      return await this.templatesService.instantiateTemplate(userId, dto);
    } catch (error) {
      this.handleError(error);
    }
  }

  @Post('custom')
  @UseGuards(JwtAuthGuard)
  @NoProjectContext()
  @ApiBearerAuth('JWT-auth')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Publish or create a custom manuscript template' })
  @ApiResponse({ status: 201, description: 'Custom template created' })
  async createCustomTemplate(@Body() dto: CreateTemplateDto) {
    try {
      return await this.templatesService.createCustomTemplate(dto);
    } catch (error) {
      this.handleError(error);
    }
  }
}
