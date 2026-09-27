import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentUser } from '@/modules/identity/auth/decorators/user.decorator';
import { Public } from '@/modules/identity/auth/decorators/public.decorator';
import { JwtAuthGuard } from '@/modules/identity/auth/guards/auth.guard';
import { BypassEnvelope } from '@/core/decorators/bypass.decorator';
import { IntegrationsService } from './integrations.service';
import {
  IntegrationProviderType,
  isValidProvider,
} from './providers/integration-provider.interface';
import { InitiateOAuthQueryDto } from './dto/initiate-oauth.dto';
import { SyncCollectionDto } from './dto/sync-collection.dto';
import {
  CreateGithubRepoDto,
  LinkGithubRepoDto,
  PushGithubDto,
  PullGithubDto,
} from './dto/github-sync.dto';

@ApiTags('Integrations')
@Controller('api/v1/integrations')
@UseGuards(JwtAuthGuard)
export class IntegrationsController {
  constructor(private readonly service: IntegrationsService) {}

  @Get('status')
  @ApiOperation({ summary: 'Get current integration connection statuses for user' })
  async getStatus(@CurrentUser('id') userId: string) {
    return await this.service.getStatus(userId);
  }

  // ============================================================================
  // GitHub Repository Specific Endpoints (Placed before parameterized routes)
  // ============================================================================

  @Get('github/repos')
  @ApiOperation({ summary: 'List repositories belonging to connected GitHub account' })
  async listGithubRepos(@CurrentUser('id') userId: string) {
    return await this.service.listCollections(userId, 'github');
  }

  @Get('github/branches')
  @ApiOperation({ summary: 'List branches for a GitHub repository' })
  async listGithubBranches(
    @CurrentUser('id') userId: string,
    @Query('repoFullName') repoFullName: string,
  ) {
    if (!repoFullName) {
      throw new BadRequestException('repoFullName query parameter is required');
    }
    return await this.service.listGithubBranches(userId, repoFullName);
  }

  @Post('github/repos')
  @ApiOperation({ summary: 'Create a new GitHub repository' })
  async createGithubRepo(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateGithubRepoDto,
  ) {
    return await this.service.createGithubRepo(userId, dto);
  }

  @Get('github/projects/:projectId')
  @ApiOperation({ summary: 'Get GitHub link status for a project' })
  async getProjectGithubLink(
    @CurrentUser('id') userId: string,
    @Param('projectId') projectId: string,
  ) {
    return await this.service.getProjectGithubLink(userId, projectId);
  }

  @Post('github/projects/link')
  @ApiOperation({ summary: 'Link a project to a GitHub repository' })
  async linkProjectGithub(
    @CurrentUser('id') userId: string,
    @Body() dto: LinkGithubRepoDto,
  ) {
    return await this.service.linkProjectGithub(userId, dto);
  }

  @Post('github/projects/push')
  @ApiOperation({ summary: 'Push manuscript files to linked GitHub repository' })
  async pushProjectGithub(
    @CurrentUser('id') userId: string,
    @Body() dto: PushGithubDto,
  ) {
    return await this.service.pushProjectToGithub(userId, dto);
  }

  @Post('github/projects/pull')
  @ApiOperation({ summary: 'Pull latest files from linked GitHub repository into project' })
  async pullProjectGithub(
    @CurrentUser('id') userId: string,
    @Body() dto: PullGithubDto,
  ) {
    return await this.service.pullProjectFromGithub(userId, dto);
  }

  // ============================================================================
  // Parameterized Provider Endpoints
  // ============================================================================

  @Get(':provider/auth-url')
  @ApiOperation({ summary: 'Generate authorization URL for OAuth popup' })
  async getAuthUrl(
    @CurrentUser('id') userId: string,
    @Param('provider') provider: string,
    @Query() query: InitiateOAuthQueryDto,
    @Req() req: FastifyRequest,
  ) {
    if (!isValidProvider(provider)) {
      throw new BadRequestException(`Invalid integration provider: ${provider}`);
    }

    const host = (req.headers.host as string) || req.hostname;
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
    const baseUrl = process.env.API_URL || `${proto}://${host}`;
    const defaultCallback = `${baseUrl.replace(/\/$/, '')}/api/v1/integrations/${provider}/callback`;
    const redirectUri = query.redirectUri || defaultCallback;

    return await this.service.initiateOAuth(userId, provider, redirectUri);
  }

  @Public()
  @BypassEnvelope()
  @Get(':provider/callback')
  @ApiOperation({ summary: 'Public OAuth callback endpoint for popup handshake' })
  async handleCallback(
    @Param('provider') provider: string,
    @Query() query: Record<string, string>,
    @Req() req: FastifyRequest,
    @Res() res: FastifyReply,
  ) {
    if (!isValidProvider(provider)) {
      res.type('text/html').send(`<h3>Invalid provider</h3><script>window.close();</script>`);
      return;
    }

    try {
      const codeOrToken = query.oauth_token || query.code || '';
      const verifier = query.oauth_verifier || '';
      const state = query.state || '';

      const userIdMatch = state.match(/state_([^_]+)_/);
      const userId = userIdMatch ? userIdMatch[1] : 'anonymous-user';

      const host = (req.headers.host as string) || req.hostname;
      const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
      const baseUrl = process.env.API_URL || `${proto}://${host}`;
      const redirectUri = `${baseUrl.replace(/\/$/, '')}/api/v1/integrations/${provider}/callback`;

      await this.service.handleCallback({
        userId,
        provider,
        codeOrToken,
        verifier,
        state,
        redirectUri,
      });

      const html = `<!DOCTYPE html>
<html>
<head><title>Authorization Successful</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #09090b; color: #f4f4f5;">
  <div style="text-align: center;">
    <h2>Connected Successfully</h2>
    <p>Returning to Flux...</p>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({ type: 'OAUTH_SUCCESS', provider: '${provider}' }, '*');
        setTimeout(() => window.close(), 500);
      } else {
        window.location.href = '/settings/integrations';
      }
    } catch (e) {
      window.close();
    }
  </script>
</body>
</html>`;

      res.type('text/html').send(html);
    } catch (err: any) {
      const errorHtml = `<!DOCTYPE html>
<html>
<head><title>Authorization Failed</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #09090b; color: #ef4444;">
  <div style="text-align: center;">
    <h2>Authorization Error</h2>
    <p>${err.message || 'Failed to exchange credentials'}</p>
    <button onclick="window.close()" style="margin-top: 1rem; padding: 0.5rem 1rem; cursor: pointer;">Close Window</button>
  </div>
</body>
</html>`;
      res.type('text/html').send(errorHtml);
    }
  }

  @Delete(':provider')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Disconnect third-party integration' })
  async disconnect(
    @CurrentUser('id') userId: string,
    @Param('provider') provider: string,
  ) {
    if (!isValidProvider(provider)) {
      throw new BadRequestException(`Invalid integration provider: ${provider}`);
    }
    await this.service.disconnect(userId, provider);
  }

  @Get(':provider/collections')
  @ApiOperation({ summary: 'List collections from connected third-party library' })
  async listCollections(
    @CurrentUser('id') userId: string,
    @Param('provider') provider: string,
  ) {
    if (!isValidProvider(provider)) {
      throw new BadRequestException(`Invalid integration provider: ${provider}`);
    }
    return await this.service.listCollections(userId, provider);
  }

  @Post(':provider/sync')
  @ApiOperation({ summary: 'Sync remote collection to project references.bib file' })
  async syncProject(
    @CurrentUser('id') userId: string,
    @Param('provider') provider: string,
    @Body() dto: SyncCollectionDto,
  ) {
    if (!isValidProvider(provider)) {
      throw new BadRequestException(`Invalid integration provider: ${provider}`);
    }

    return await this.service.syncProjectCollection(userId, provider, dto);
  }
}
