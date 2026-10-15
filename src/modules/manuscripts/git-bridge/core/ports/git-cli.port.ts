/**
 * git-bridge/core/ports/git-cli.port.ts
 * Driven port for Git CLI repository operations and Smart-HTTP RPC execution.
 */

import { Readable } from 'stream';
import { GitService } from '@/modules/manuscripts/git-bridge/core/domain/git-bridge.domain';

export const GIT_CLI_PORT = Symbol('GIT_CLI_PORT');

export interface GitRunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface IGitCliPort {
  bareDir(projectId: string): string;
  workDir(projectId: string): string;
  run(
    args: string[],
    opts?: { env?: NodeJS.ProcessEnv; cwd?: string; input?: Buffer },
  ): Promise<GitRunResult>;
  ensureRepo(projectId: string): Promise<void>;
  resolveRef(projectId: string, ref?: string): Promise<string | null>;
  listRefs(projectId: string): Promise<string[]>;
  deleteRef(projectId: string, ref: string): Promise<void>;
  setMainRef(
    projectId: string,
    sha: string,
    expectedOld: string | null,
  ): Promise<void>;
  commitSnapshot(
    projectId: string,
    files: Array<{ path: string; content: Buffer }>,
    message: string,
  ): Promise<string>;
  advertiseRefs(projectId: string, service: GitService): Promise<Buffer>;
  serviceRpc(
    projectId: string,
    service: GitService,
    body: Readable,
  ): Promise<GitRunResult>;
  diffNameStatus(
    projectId: string,
    from: string | null,
    to: string,
  ): Promise<string>;
  readBlob(
    projectId: string,
    commit: string,
    repoPath: string,
  ): Promise<Buffer>;
}
