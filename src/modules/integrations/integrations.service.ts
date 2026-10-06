import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
  Logger,
} from '@nestjs/common';
import { IntegrationsRepository } from './integrations.repository';
import {
  IIntegrationProvider,
  INTEGRATION_PROVIDERS,
  IntegrationProviderType,
  OAuthInitiationResult,
  RemoteCollectionItem,
} from './providers/integration-provider.interface';
import { ZoteroProvider } from './providers/zotero.provider';
import { MendeleyProvider } from './providers/mendeley.provider';
import { GithubProvider } from './providers/github.provider';
import { decryptToken, encryptToken } from './utils/integration-crypto.utils';
import { FilestoreService } from '@/modules/manuscripts/filestore/filestore.service';
import { DocstoreService } from '@/modules/manuscripts/docstore/docstore.service';
import { StructureService } from '@/modules/manuscripts/structure/structure.service';
import { SyncCollectionDto } from './dto/sync-collection.dto';
import {
  CreateGithubRepoDto,
  LinkGithubRepoDto,
  PushGithubDto,
  PullGithubDto,
  ImportGithubRepoDto,
} from './dto/github-sync.dto';
import { IManuscriptAggregatorPort } from '@/modules/manuscripts/export-import/core/ports/manuscript-aggregator.port';
import { IManuscriptHydratorPort } from '@/modules/manuscripts/export-import/core/ports/manuscript-hydrator.port';
import { ArchiveEntryVo } from '@/modules/manuscripts/export-import/core/domain/value-objects/archive-entry.vo';

export interface ProviderStatusSummary {
  provider: IntegrationProviderType;
  name: string;
  description: string;
  category: 'reference' | 'identity' | 'git';
  status: string;
  accountName?: string | null;
  accountEmail?: string | null;
  lastSyncedAt?: Date | null;
  connectedAt?: Date | null;
  needsReconnect: boolean;
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);
  private readonly providers = new Map<
    IntegrationProviderType,
    IIntegrationProvider
  >();

  constructor(
    private readonly repo: IntegrationsRepository,
    private readonly zoteroProvider: ZoteroProvider,
    private readonly mendeleyProvider: MendeleyProvider,
    private readonly githubProvider: GithubProvider,
    private readonly filestoreService: FilestoreService,
    private readonly aggregator: IManuscriptAggregatorPort,
    private readonly hydrator: IManuscriptHydratorPort,
    @Optional() private readonly docstoreService?: DocstoreService,
    @Optional() private readonly structureService?: StructureService,
  ) {
    this.providers.set(this.zoteroProvider.provider, this.zoteroProvider);
    this.providers.set(this.mendeleyProvider.provider, this.mendeleyProvider);
    this.providers.set(this.githubProvider.provider, this.githubProvider);
  }

  private getProvider(provider: IntegrationProviderType): IIntegrationProvider {
    const instance = this.providers.get(provider);
    if (!instance) {
      throw new NotFoundException(
        `Unsupported integration provider: ${provider}`,
      );
    }
    return instance;
  }

  async getStatus(userId: string): Promise<ProviderStatusSummary[]> {
    const connections = await this.repo.findAllUserConnections(userId);
    const connectionMap = new Map(connections.map((c) => [c.provider, c]));

    const metadata: Record<
      IntegrationProviderType,
      {
        name: string;
        description: string;
        category: 'reference' | 'identity' | 'git';
      }
    > = {
      zotero: {
        name: 'Zotero',
        description:
          'Sync collections, references, and PDF metadata from your personal or group library.',
        category: 'reference',
      },
      mendeley: {
        name: 'Mendeley',
        description:
          'Connect your Elsevier Mendeley reference manager library directly to Flux.',
        category: 'reference',
      },
      orcid: {
        name: 'ORCID',
        description:
          'Connect your researcher profile to automatically sync your published works.',
        category: 'identity',
      },
      github: {
        name: 'GitHub',
        description:
          'Two-way sync manuscripts with GitHub repositories, branches, and commits.',
        category: 'git',
      },
    };

    return INTEGRATION_PROVIDERS.map((provider) => {
      const conn = connectionMap.get(provider);
      const meta = metadata[provider];

      if (!conn) {
        return {
          provider,
          name: meta.name,
          description: meta.description,
          category: meta.category,
          status: 'revoked',
          needsReconnect: false,
        };
      }

      const needsReconnect = Boolean(
        conn.authFailedAt || conn.status !== 'connected',
      );

      return {
        provider,
        name: meta.name,
        description: meta.description,
        category: meta.category,
        status: conn.status,
        accountName: conn.accountName,
        accountEmail: conn.accountEmail,
        lastSyncedAt: conn.lastSyncedAt,
        connectedAt: conn.connectedAt,
        needsReconnect,
      };
    });
  }

  async initiateOAuth(
    userId: string,
    provider: IntegrationProviderType,
    redirectUri: string,
  ): Promise<OAuthInitiationResult> {
    return this.getProvider(provider).initiateOAuth(userId, redirectUri);
  }

  async handleCallback(params: {
    userId: string;
    provider: IntegrationProviderType;
    codeOrToken: string;
    verifier?: string;
    state?: string;
    secret?: string;
    redirectUri: string;
  }): Promise<void> {
    const providerInstance = this.getProvider(params.provider);

    const exchange = await providerInstance.handleCallback({
      codeOrToken: params.codeOrToken,
      verifier: params.verifier,
      state: params.state,
      secret: params.secret,
      redirectUri: params.redirectUri,
    });

    const targetUserId = exchange.userId || params.userId;

    if (!targetUserId || targetUserId === 'anonymous-user') {
      throw new BadRequestException(
        'Unable to identify the authenticated user session for this integration. Please ensure you are logged into Flux and try connecting again.',
      );
    }

    const encryptedAccess = encryptToken(exchange.accessToken);
    const encryptedRefresh = exchange.refreshToken
      ? encryptToken(exchange.refreshToken)
      : null;
    const tokenExpiresAt = exchange.expiresInSeconds
      ? new Date(Date.now() + exchange.expiresInSeconds * 1000)
      : null;

    await this.repo.upsertConnection({
      userId: targetUserId,
      provider: params.provider,
      accessToken: encryptedAccess,
      refreshToken: encryptedRefresh,
      tokenExpiresAt,
      providerUserId: exchange.providerUserId,
      accountName: exchange.accountName,
      accountEmail: exchange.accountEmail,
      metadata: exchange.metadata,
    });
  }

  async disconnect(
    userId: string,
    provider: IntegrationProviderType,
  ): Promise<void> {
    await this.repo.deleteConnection(userId, provider);
  }

  async listCollections(
    userId: string,
    provider: IntegrationProviderType,
  ): Promise<RemoteCollectionItem[]> {
    const conn = await this.repo.findConnection(userId, provider);
    if (!conn) {
      throw new NotFoundException(
        `No active connection found for provider: ${provider}`,
      );
    }

    if (conn.authFailedAt || conn.status !== 'connected') {
      throw new BadRequestException(
        'Integration authentication is expired or invalid.',
      );
    }

    const providerInstance = this.getProvider(provider);
    const decryptedToken = decryptToken(conn.accessToken);

    try {
      return await providerInstance.fetchCollections(
        decryptedToken,
        conn.providerUserId,
      );
    } catch (err: any) {
      if (err?.message?.includes('401') || err?.message?.includes('403')) {
        await this.repo.markAuthFailed(userId, provider);
      }
      throw err;
    }
  }

  async syncProjectCollection(
    userId: string,
    provider: IntegrationProviderType,
    dto: SyncCollectionDto,
  ) {
    const conn = await this.repo.findConnection(userId, provider);
    if (!conn) {
      throw new NotFoundException(
        `No active connection found for provider: ${provider}`,
      );
    }

    if (conn.authFailedAt || conn.status !== 'connected') {
      throw new BadRequestException(
        'Integration authentication is expired or invalid.',
      );
    }

    const providerInstance = this.getProvider(provider);
    const decryptedToken = decryptToken(conn.accessToken);

    const bibtexContent = await providerInstance.fetchCollectionBibtex(
      decryptedToken,
      conn.providerUserId,
      dto.collectionId,
    );

    const targetBibFile = dto.targetBibFile || 'references.bib';
    const bibBuffer = Buffer.from(bibtexContent, 'utf-8');

    await this.filestoreService.uploadFileFromBuffer(
      dto.projectId,
      targetBibFile,
      bibBuffer,
      'application/x-bibtex',
    );

    // Also sync document into Docstore & Structure tree for instant editor availability
    if (this.docstoreService && this.structureService) {
      try {
        const existingNode = await this.structureService.getNodeByPath(
          dto.projectId,
          targetBibFile,
        );
        if (existingNode && existingNode.docId) {
          const lines = bibtexContent.split(/\r?\n/);
          await this.docstoreService.updateDoc(
            dto.projectId,
            existingNode.docId,
            {
              lines,
              version: 1,
            },
          );
        } else {
          const doc = await this.docstoreService.createDoc(dto.projectId, {
            path: targetBibFile,
            text: bibtexContent,
          });
          await this.structureService.createNode(dto.projectId, {
            name: targetBibFile,
            type: 'DOC',
            docId: doc._id,
          });
        }
      } catch (docErr: any) {
        this.logger.warn(
          `Could not sync docstore node for ${targetBibFile}: ${docErr.message}`,
        );
      }
    }

    const link = await this.repo.upsertProjectLink({
      projectId: dto.projectId,
      userIntegrationId: conn.id,
      collectionId: dto.collectionId,
      collectionName: dto.collectionName || dto.collectionId,
      targetBibFile,
    });

    await this.repo.updateProjectLinkLastSynced(link.id);

    return {
      linkId: link.id,
      collectionId: link.collectionId,
      collectionName: link.collectionName,
      targetBibFile: link.targetBibFile,
      syncedAt: new Date(),
      bibtexLength: bibtexContent.length,
    };
  }

  // ============================================================================
  // GitHub-Specific Specialized Workflows
  // ============================================================================

  private async getDecryptedGithubToken(
    userId: string,
  ): Promise<{ token: string; connId: string }> {
    const conn = await this.repo.findConnection(userId, 'github');
    if (!conn) {
      throw new NotFoundException(
        'GitHub is not connected. Please connect your GitHub account first.',
      );
    }

    if (conn.authFailedAt || conn.status !== 'connected') {
      throw new BadRequestException(
        'GitHub authorization has expired. Please reconnect.',
      );
    }

    const token = decryptToken(conn.accessToken);
    return { token, connId: conn.id };
  }

  async listGithubBranches(
    userId: string,
    repoFullName: string,
  ): Promise<string[]> {
    const { token } = await this.getDecryptedGithubToken(userId);
    return await this.githubProvider.listBranches(token, repoFullName);
  }

  async createGithubRepo(userId: string, dto: CreateGithubRepoDto) {
    const { token } = await this.getDecryptedGithubToken(userId);
    return await this.githubProvider.createRepository(
      token,
      dto.name,
      dto.private ?? true,
      dto.description,
    );
  }

  async linkProjectGithub(userId: string, dto: LinkGithubRepoDto) {
    const { connId } = await this.getDecryptedGithubToken(userId);
    const branch = dto.branch || 'main';

    const link = await this.repo.upsertProjectLink({
      projectId: dto.projectId,
      userIntegrationId: connId,
      collectionId: dto.repoFullName,
      collectionName: dto.repoFullName,
      targetBibFile: branch,
    });

    return {
      linkId: link.id,
      projectId: link.projectId,
      repoFullName: link.collectionId,
      branch: link.targetBibFile,
      lastSyncedAt: link.lastSyncedAt,
    };
  }

  async getProjectGithubLink(userId: string, projectId: string) {
    const conn = await this.repo.findConnection(userId, 'github');
    if (!conn) {
      return { isConnected: false, link: null };
    }

    const link = await this.repo.findProjectLink(projectId, conn.id);
    return {
      isConnected: true,
      accountName: conn.accountName,
      link: link
        ? {
            id: link.id,
            repoFullName: link.collectionId,
            branch: link.targetBibFile,
            lastSyncedAt: link.lastSyncedAt,
          }
        : null,
    };
  }

  async pushProjectToGithub(userId: string, dto: PushGithubDto) {
    const { token, connId } = await this.getDecryptedGithubToken(userId);

    const link = await this.repo.findProjectLink(dto.projectId, connId);
    if (!link) {
      throw new BadRequestException(
        'This project is not linked to a GitHub repository. Please link a repository first.',
      );
    }

    const repoFullName = link.collectionId;
    const branch = dto.branch || link.targetBibFile || 'main';

    // 1. Gather all project entries (text documents and binary assets)
    const entries = await this.aggregator.collectProjectEntries(
      dto.projectId,
      false,
    );
    if (entries.length === 0) {
      throw new BadRequestException('Project has no files to commit.');
    }

    // 2. Commit and push tree to GitHub
    const pushResult = await this.githubProvider.pushProjectTree({
      decryptedToken: token,
      repoFullName,
      branch,
      files: entries,
      commitMessage: dto.commitMessage,
    });

    // 3. Mark link as synced
    await this.repo.updateProjectLinkLastSynced(link.id);

    return {
      success: true,
      repoFullName,
      branch,
      commitSha: pushResult.commitSha,
      commitUrl: pushResult.commitUrl,
      fileCount: entries.length,
      syncedAt: new Date(),
    };
  }

  async pullProjectFromGithub(userId: string, dto: PullGithubDto) {
    const { token, connId } = await this.getDecryptedGithubToken(userId);

    const link = await this.repo.findProjectLink(dto.projectId, connId);
    if (!link) {
      throw new BadRequestException(
        'This project is not linked to a GitHub repository. Please link a repository first.',
      );
    }

    const repoFullName = link.collectionId;
    const branch = dto.branch || link.targetBibFile || 'main';

    // 1. Fetch all blobs from GitHub tree
    const pulledFiles = await this.githubProvider.pullProjectTree({
      decryptedToken: token,
      repoFullName,
      branch,
    });

    if (pulledFiles.length === 0) {
      throw new BadRequestException(
        `No files found in ${repoFullName} on branch ${branch}.`,
      );
    }

    // 2. Wrap into ArchiveEntryVo for safe reconstitution
    const archiveEntries = pulledFiles.map((file) =>
      ArchiveEntryVo.create(file.path, file.data),
    );

    // 3. Hydrate project entries via domain port
    const summary = await this.hydrator.hydrateProjectEntries(
      dto.projectId,
      archiveEntries,
      userId,
    );

    // 4. Mark link as synced
    await this.repo.updateProjectLinkLastSynced(link.id);

    return {
      success: true,
      repoFullName,
      branch,
      filesImported: pulledFiles.length,
      syncedAt: new Date(),
      summary: summary.toJSON(),
    };
  }

  async importGithubRepo(userId: string, dto: ImportGithubRepoDto) {
    const { token, connId } = await this.getDecryptedGithubToken(userId);
    const branch = dto.branch || 'main';

    // 1. Fetch all blobs from GitHub tree
    const pulledFiles = await this.githubProvider.pullProjectTree({
      decryptedToken: token,
      repoFullName: dto.repoFullName,
      branch,
    });

    if (pulledFiles.length === 0) {
      throw new BadRequestException(
        `No files found in ${dto.repoFullName} on branch ${branch}.`,
      );
    }

    // 2. Wrap into ArchiveEntryVo
    const archiveEntries = pulledFiles.map((file) =>
      ArchiveEntryVo.create(file.path, file.data),
    );

    // 3. Hydrate project entries
    const summary = await this.hydrator.hydrateProjectEntries(
      dto.projectId,
      archiveEntries,
      userId,
    );

    // 4. Link or update link
    const link = await this.repo.upsertProjectLink({
      projectId: dto.projectId,
      userIntegrationId: connId,
      collectionId: dto.repoFullName,
      collectionName: dto.repoFullName,
      targetBibFile: branch,
    });
    await this.repo.updateProjectLinkLastSynced(link.id);

    return {
      success: true,
      repoFullName: dto.repoFullName,
      branch,
      filesImported: pulledFiles.length,
      syncedAt: new Date(),
      rootDocId: summary.rootDocId,
      rootDocPath: summary.rootDocPath,
      summary: summary.toJSON(),
    };
  }
}
