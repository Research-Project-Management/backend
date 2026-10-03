import {
  encryptToken,
  decryptToken,
} from '@/modules/integrations/utils/integration-crypto.utils';
import { ZoteroProvider } from '@/modules/integrations/providers/zotero.provider';
import { MendeleyProvider } from '@/modules/integrations/providers/mendeley.provider';
import { GithubProvider } from '@/modules/integrations/providers/github.provider';
import { IntegrationsService } from '@/modules/integrations/integrations.service';
import { IntegrationsRepository } from '@/modules/integrations/integrations.repository';
import { PluggableLibrarySyncAdapter } from '@/modules/manuscripts/citations/core/adapters/library/pluggable-library-sync.adapter';

describe('Integrations Subsystem Unit Tests (Pragmatic Architecture)', () => {
  describe('Crypto Utils (AES-256-GCM)', () => {
    it('should successfully encrypt and decrypt a sensitive token', () => {
      const originalToken = 'zotero_secret_api_key_xyz987654321';
      const encrypted = encryptToken(originalToken);

      expect(encrypted).not.toEqual(originalToken);
      expect(encrypted.split(':')).toHaveLength(3); // iv:authTag:ciphertext

      const decrypted = decryptToken(encrypted);
      expect(decrypted).toEqual(originalToken);
    });

    it('should fail decryption if ciphertext is tampered', () => {
      const originalToken = 'secret_token_123';
      const encrypted = encryptToken(originalToken);
      const [iv, authTag, ciphertext] = encrypted.split(':');

      // Tamper ciphertext
      const tamperedCiphertext = ciphertext.slice(0, -2) + 'aa';
      const tamperedPayload = `${iv}:${authTag}:${tamperedCiphertext}`;

      expect(() => decryptToken(tamperedPayload)).toThrow();
    });

    it('should throw when payload format is invalid', () => {
      expect(() => decryptToken('invalid-format-payload')).toThrow(
        'Invalid cipher payload format',
      );
    });
  });

  describe('ZoteroProvider', () => {
    let provider: ZoteroProvider;

    beforeEach(() => {
      provider = new ZoteroProvider();
    });

    it('should initiate OAuth and return authUrl with state', async () => {
      const result = await provider.initiateOAuth(
        'user_123',
        'http://localhost:3000/callback',
      );
      expect(result.authUrl).toBeDefined();
      expect(result.state).toContain('user_123');
    });

    it('should handle callback and return token credentials', async () => {
      const exchange = await provider.handleCallback({
        codeOrToken: 'mock_token_123',
        verifier: 'mock_verifier',
        redirectUri: 'http://localhost:3000/callback',
      });

      expect(exchange.accessToken).toBeDefined();
      expect(exchange.providerUserId).toBeDefined();
    });

    it('should fetch remote collections', async () => {
      const collections = await provider.fetchCollections(
        'mock_key_xyz',
        '1234567',
      );
      expect(Array.isArray(collections)).toBe(true);
      expect(collections.length).toBeGreaterThan(0);
      expect(collections[0]).toHaveProperty('id');
      expect(collections[0]).toHaveProperty('name');
    });

    it('should fetch BibTeX content for collection', async () => {
      const bibtex = await provider.fetchCollectionBibtex(
        'mock_key_xyz',
        '1234567',
        'COLL_1',
      );
      expect(bibtex).toContain('@article');
      expect(bibtex).toContain('title');
    });
  });

  describe('MendeleyProvider', () => {
    let provider: MendeleyProvider;

    beforeEach(() => {
      provider = new MendeleyProvider();
    });

    it('should initiate OAuth 2.0 and return authUrl with state', async () => {
      const result = await provider.initiateOAuth(
        'user_456',
        'http://localhost:3000/callback',
      );
      expect(result.authUrl).toBeDefined();
      expect(result.state).toContain('user_456');
    });

    it('should handle OAuth 2.0 callback and return token credentials', async () => {
      const exchange = await provider.handleCallback({
        codeOrToken: 'mock_code_mendeley_789',
        redirectUri: 'http://localhost:3000/callback',
      });

      expect(exchange.accessToken).toBeDefined();
      expect(exchange.providerUserId).toBeDefined();
      expect(exchange.accountName).toContain('Mendeley Researcher');
    });

    it('should fetch remote folders/collections', async () => {
      const collections = await provider.fetchCollections(
        'mock_token_abc',
        'mendeley_user_883921',
      );
      expect(Array.isArray(collections)).toBe(true);
      expect(collections.length).toBeGreaterThan(0);
      expect(collections[0]).toHaveProperty('id');
      expect(collections[0]).toHaveProperty('name');
    });

    it('should fetch BibTeX content for Mendeley collection', async () => {
      const bibtex = await provider.fetchCollectionBibtex(
        'mock_token_abc',
        'mendeley_user_883921',
        'mendeley_f1',
      );
      expect(bibtex).toContain('@article');
      expect(bibtex).toContain('title');
    });
  });

  describe('GithubProvider', () => {
    let provider: GithubProvider;

    beforeEach(() => {
      provider = new GithubProvider();
    });

    it('should initiate OAuth with repo scope', async () => {
      const result = await provider.initiateOAuth(
        'user_github_1',
        'http://localhost:3000/callback',
      );
      expect(result.authUrl).toBeDefined();
      expect(result.state).toContain('user_github_1');
    });

    it('should handle callback and return GitHub profile details', async () => {
      const exchange = await provider.handleCallback({
        codeOrToken: 'mock_github_code_123',
        redirectUri: 'http://localhost:3000/callback',
      });

      expect(exchange.accessToken).toBeDefined();
      expect(exchange.accountName).toBe('octocat');
      expect(exchange.accountEmail).toContain('octocat');
    });

    it('should list repositories as collections', async () => {
      const repos = await provider.fetchCollections(
        'github_mock_token',
        'github_user_441928',
      );
      expect(Array.isArray(repos)).toBe(true);
      expect(repos.length).toBeGreaterThan(0);
      expect(repos[0]).toHaveProperty('id');
      expect(repos[0]).toHaveProperty('name');
    });

    it('should list repository branches', async () => {
      const branches = await provider.listBranches(
        'github_mock_token',
        'octocat/research-manuscript',
      );
      expect(branches).toContain('main');
    });

    it('should push and pull project trees in mock mode', async () => {
      const pushRes = await provider.pushProjectTree({
        decryptedToken: 'github_mock_token',
        repoFullName: 'octocat/research-manuscript',
        branch: 'main',
        files: [
          {
            path: 'main.tex',
            data: Buffer.from('\\begin{document}Hello\\end{document}'),
          },
        ],
        commitMessage: 'Initial manuscript commit',
      });
      expect(pushRes.commitSha).toBeDefined();
      expect(pushRes.commitUrl).toContain('octocat/research-manuscript');

      const pulled = await provider.pullProjectTree({
        decryptedToken: 'github_mock_token',
        repoFullName: 'octocat/research-manuscript',
        branch: 'main',
      });
      expect(pulled.length).toBeGreaterThan(0);
      expect(pulled[0].path).toBe('main.tex');
    });
  });

  describe('IntegrationsService', () => {
    let service: IntegrationsService;
    let mockRepo: jest.Mocked<IntegrationsRepository>;
    let zoteroProvider: ZoteroProvider;
    let mendeleyProvider: MendeleyProvider;
    let githubProvider: GithubProvider;
    let mockFilestore: any;
    let mockAggregator: any;
    let mockHydrator: any;

    beforeEach(() => {
      mockRepo = {
        findConnection: jest.fn(),
        findAllUserConnections: jest.fn(),
        upsertConnection: jest.fn(),
        markAuthFailed: jest.fn(),
        deleteConnection: jest.fn(),
        upsertProjectLink: jest.fn(),
        updateProjectLinkLastSynced: jest.fn(),
        findProjectLink: jest.fn(),
      } as any;

      zoteroProvider = new ZoteroProvider();
      mendeleyProvider = new MendeleyProvider();
      githubProvider = new GithubProvider();
      mockFilestore = {
        uploadFileFromBuffer: jest.fn().mockResolvedValue({ id: 'file_bib_1' }),
      };
      mockAggregator = {
        collectProjectEntries: jest.fn().mockResolvedValue([
          {
            path: 'main.tex',
            data: Buffer.from('\\begin{document}Paper\\end{document}'),
          },
        ]),
      };
      mockHydrator = {
        hydrateProjectEntries: jest.fn().mockResolvedValue({
          toJSON: () => ({ totalDocs: 1, totalFiles: 0, totalFolders: 0 }),
        }),
      };

      service = new IntegrationsService(
        mockRepo,
        zoteroProvider,
        mendeleyProvider,
        githubProvider,
        mockFilestore,
        mockAggregator,
        mockHydrator,
      );
    });

    it('should return all 4 supported providers with appropriate connection flags', async () => {
      const mockConn: any = {
        id: 'conn_1',
        userId: 'user_1',
        provider: 'zotero',
        status: 'connected',
        accessToken: 'enc_token',
        providerUserId: 'zot_user_1',
        accountName: 'John Doe',
        connectedAt: new Date(),
        updatedAt: new Date(),
        authFailedAt: null,
      };

      mockRepo.findAllUserConnections.mockResolvedValue([mockConn]);

      const statuses = await service.getStatus('user_1');
      expect(statuses).toHaveLength(4); // zotero, mendeley, orcid, github

      const zoteroStatus = statuses.find((s) => s.provider === 'zotero');
      expect(zoteroStatus?.status).toBe('connected');
      expect(zoteroStatus?.accountName).toBe('John Doe');
      expect(zoteroStatus?.needsReconnect).toBe(false);

      const githubStatus = statuses.find((s) => s.provider === 'github');
      expect(githubStatus?.status).toBe('revoked');
      expect(githubStatus?.category).toBe('git');
    });

    it('should flag needsReconnect when authFailedAt is present', async () => {
      const failedConn: any = {
        id: 'conn_2',
        userId: 'user_1',
        provider: 'zotero',
        status: 'error',
        accessToken: 'enc_token',
        providerUserId: 'zot_user_1',
        authFailedAt: new Date(),
        connectedAt: new Date(),
        updatedAt: new Date(),
      };

      mockRepo.findAllUserConnections.mockResolvedValue([failedConn]);

      const statuses = await service.getStatus('user_1');
      const zoteroStatus = statuses.find((s) => s.provider === 'zotero');
      expect(zoteroStatus?.needsReconnect).toBe(true);
    });

    it('should sync project collection, write file to filestore and update lastSynced', async () => {
      const encToken = encryptToken('mock_key_abc');
      const conn: any = {
        id: 'conn_10',
        userId: 'user_1',
        provider: 'zotero',
        status: 'connected',
        accessToken: encToken,
        providerUserId: '1234567',
        authFailedAt: null,
      };

      mockRepo.findConnection.mockResolvedValue(conn);
      mockRepo.upsertProjectLink.mockResolvedValue({
        id: 'link_1',
        projectId: 'proj_1',
        userIntegrationId: 'conn_10',
        collectionId: 'COLL_1',
        collectionName: 'My Pubs',
        targetBibFile: 'references.bib',
        lastSyncedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.syncProjectCollection('user_1', 'zotero', {
        projectId: 'proj_1',
        collectionId: 'COLL_1',
        collectionName: 'My Pubs',
      });

      expect(result.linkId).toBe('link_1');
      expect(result.bibtexLength).toBeGreaterThan(0);
      expect(mockFilestore.uploadFileFromBuffer).toHaveBeenCalledWith(
        'proj_1',
        'references.bib',
        expect.any(Buffer),
        'application/x-bibtex',
      );
      expect(mockRepo.updateProjectLinkLastSynced).toHaveBeenCalledWith(
        'link_1',
      );
    });

    it('should push project to GitHub repository', async () => {
      const encToken = encryptToken('github_mock_token');
      const conn: any = {
        id: 'conn_gh_1',
        userId: 'user_1',
        provider: 'github',
        status: 'connected',
        accessToken: encToken,
        providerUserId: 'gh_123',
        authFailedAt: null,
      };

      mockRepo.findConnection.mockResolvedValue(conn);
      mockRepo.findProjectLink.mockResolvedValue({
        id: 'link_gh_1',
        projectId: 'proj_100',
        userIntegrationId: 'conn_gh_1',
        collectionId: 'octocat/research-manuscript',
        collectionName: 'octocat/research-manuscript',
        targetBibFile: 'main',
        lastSyncedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const pushRes = await service.pushProjectToGithub('user_1', {
        projectId: 'proj_100',
        commitMessage: 'Synced via Flux',
      });

      expect(pushRes.success).toBe(true);
      expect(pushRes.repoFullName).toBe('octocat/research-manuscript');
      expect(mockRepo.updateProjectLinkLastSynced).toHaveBeenCalledWith(
        'link_gh_1',
      );
    });

    it('should pull project from GitHub repository', async () => {
      const encToken = encryptToken('github_mock_token');
      const conn: any = {
        id: 'conn_gh_1',
        userId: 'user_1',
        provider: 'github',
        status: 'connected',
        accessToken: encToken,
        providerUserId: 'gh_123',
        authFailedAt: null,
      };

      mockRepo.findConnection.mockResolvedValue(conn);
      mockRepo.findProjectLink.mockResolvedValue({
        id: 'link_gh_1',
        projectId: 'proj_100',
        userIntegrationId: 'conn_gh_1',
        collectionId: 'octocat/research-manuscript',
        collectionName: 'octocat/research-manuscript',
        targetBibFile: 'main',
        lastSyncedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const pullRes = await service.pullProjectFromGithub('user_1', {
        projectId: 'proj_100',
      });

      expect(pullRes.success).toBe(true);
      expect(pullRes.filesImported).toBeGreaterThan(0);
      expect(mockHydrator.hydrateProjectEntries).toHaveBeenCalled();
      expect(mockRepo.updateProjectLinkLastSynced).toHaveBeenCalledWith(
        'link_gh_1',
      );
    });
  });

  describe('PluggableLibrarySyncAdapter (Zotero Official API Bridge)', () => {
    let adapter: PluggableLibrarySyncAdapter;
    let mockRepo: any;
    let zoteroProvider: ZoteroProvider;

    beforeEach(() => {
      mockRepo = {
        findConnection: jest.fn(),
      };
      zoteroProvider = new ZoteroProvider();
      adapter = new PluggableLibrarySyncAdapter(
        undefined,
        mockRepo,
        zoteroProvider,
      );
    });

    it('should list remote Zotero collections when user has connected account', async () => {
      const encryptedToken = encryptToken('zotero_mock_token');
      mockRepo.findConnection.mockResolvedValue({
        id: 'conn_1',
        userId: 'user_zotero_1',
        provider: 'zotero',
        status: 'connected',
        accessToken: encryptedToken,
        providerUserId: '1234567',
        authFailedAt: null,
      });

      const collections = await adapter.listCollections('user_zotero_1');
      expect(collections.length).toBeGreaterThan(0);
      const zoteroCol = collections.find((c) => c.id.startsWith('zotero:'));
      expect(zoteroCol).toBeDefined();
      expect(zoteroCol?.name).toContain('[Zotero]');
    });

    it('should fetch remote BibTeX when collectionId starts with zotero:', async () => {
      const encryptedToken = encryptToken('zotero_mock_token');
      mockRepo.findConnection.mockResolvedValue({
        id: 'conn_1',
        userId: 'user_zotero_1',
        provider: 'zotero',
        status: 'connected',
        accessToken: encryptedToken,
        providerUserId: '1234567',
        authFailedAt: null,
      });

      const bibtex = await adapter.fetchCollectionBibtex(
        'user_zotero_1',
        'zotero:COLL_1',
      );
      expect(bibtex).toContain('@article');
      expect(bibtex).toContain('title');
    });

    it('should not fabricate mock collections when user has no Zotero connection', async () => {
      mockRepo.findConnection.mockResolvedValue(null);

      const collections = await adapter.listCollections('user_no_zotero');
      expect(
        collections.find((c: any) => c.id === 'coll-default'),
      ).toBeUndefined();
    });
  });
});
