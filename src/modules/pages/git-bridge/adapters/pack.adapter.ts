/**
 * git-bridge/adapters/pack.adapter.ts
 * GoF Adapter over native `git` Smart-HTTP wire commands (`upload-pack`, `receive-pack`, `gc`)
 * with backpressure streaming (`pause`/`drain`, O(64 KB) heap).
 */

import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { readPagesConfig } from '../../core/config/pages.config';
import { GitBridgeError } from '../domain/errors';
import { GitService } from '../domain/policy';
import { RepoAdapter } from './repo.adapter';

export interface RpcResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

@Injectable()
export class PackAdapter {
  private readonly logger = new Logger(PackAdapter.name);
  private readonly gitBin: string;
  private readonly staticEnv: Record<string, string>;

  constructor(private readonly repo: RepoAdapter) {
    const { gitBridge } = readPagesConfig();
    this.gitBin = gitBridge.gitBinary;
    this.staticEnv = {
      ...gitBridge.safeParentEnv,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: gitBridge.authorName,
      GIT_AUTHOR_EMAIL: gitBridge.authorEmail,
      GIT_COMMITTER_NAME: gitBridge.authorName,
      GIT_COMMITTER_EMAIL: gitBridge.authorEmail,
    };
  }

  private buildEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
    return extra ? { ...this.staticEnv, ...extra } : this.staticEnv;
  }

  public async advertiseRefs(
    repoId: string,
    service: GitService,
  ): Promise<Buffer> {
    this.repo.touch(repoId);
    const res = await this.exec([
      service.replace(/^git-/, ''),
      '--stateless-rpc',
      '--advertise-refs',
      this.repo.bareDir(repoId),
    ]);
    if (res.code !== 0) {
      throw new GitBridgeError(
        `git ${service} --advertise-refs failed (${res.code}): ${res.stderr.trim()}`,
      );
    }
    return res.stdout;
  }

  public streamUpload(
    repoId: string,
    input: Readable,
    output: Writable,
    onFirstByte: () => void,
  ): Promise<void> {
    this.repo.touch(repoId);
    const timeoutMs = 120_000;

    return new Promise<void>((resolve, reject) => {
      const child = spawn(
        this.gitBin,
        ['upload-pack', '--stateless-rpc', this.repo.bareDir(repoId)],
        { env: this.buildEnv(), windowsHide: true },
      );

      const errBufs: Buffer[] = [];
      let errBytes = 0;
      let started = false;
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        child.kill('SIGKILL');
        reject(
          new GitBridgeError(`git upload-pack timed out (${timeoutMs}ms)`),
        );
      }, timeoutMs);
      timer.unref?.();

      child.stdout.on('data', (chunk: Buffer) => {
        if (done) return;
        if (!started) {
          started = true;
          onFirstByte();
        }
        if (!output.write(chunk)) {
          child.stdout.pause();
          output.once('drain', () => {
            if (!done) child.stdout.resume();
          });
        }
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (errBytes < 64 * 1024) {
          errBufs.push(chunk);
          errBytes += chunk.length;
        }
      });

      child.stdin.on('error', (e) => {
        this.logger.debug(`git upload-pack stdin closed: ${e.message}`);
      });

      input.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.kill();
        reject(err);
      });

      child.on('error', (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);

        if ((code ?? 1) !== 0 && !started) {
          const stderr = Buffer.concat(errBufs).toString('utf8').trim();
          reject(
            new GitBridgeError(`git upload-pack failed (${code}): ${stderr}`),
          );
          return;
        }
        if (!started) onFirstByte();
        output.end();
        resolve();
      });

      input.pipe(child.stdin);
    });
  }

  public async receivePack(
    repoId: string,
    input: Readable,
  ): Promise<RpcResult> {
    this.repo.touch(repoId);
    const timeoutMs = 120_000;
    const maxBytes = 16 * 1024 * 1024;

    const res = await new Promise<RpcResult>((resolve, reject) => {
      const child = spawn(
        this.gitBin,
        [
          '-c',
          'receive.maxInputSize=209715200',
          'receive-pack',
          '--stateless-rpc',
          this.repo.bareDir(repoId),
        ],
        { env: this.buildEnv(), windowsHide: true },
      );

      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        child.kill('SIGKILL');
        reject(
          new GitBridgeError(`git receive-pack timed out (${timeoutMs}ms)`),
        );
      }, timeoutMs);
      timer.unref?.();

      child.stdout.on('data', (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes <= maxBytes) out.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        errBytes += chunk.length;
        if (errBytes <= 64 * 1024) err.push(chunk);
      });

      child.stdin.on('error', (e) => {
        this.logger.debug(`git receive-pack stdin closed: ${e.message}`);
      });

      input.on('error', (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        child.kill();
        reject(e);
      });

      child.on('error', (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      });

      child.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString('utf8'),
        });
      });

      input.pipe(child.stdin);
    });

    this.repo.clearPackCache(repoId);
    return res;
  }

  public async runGc(repoId: string): Promise<void> {
    const gitdir = this.repo.bareDir(repoId);
    try {
      await fsp.access(path.join(gitdir, 'HEAD'));
    } catch {
      return;
    }
    await this.exec(['gc', '--auto', '--quiet'], {
      env: this.buildEnv({ GIT_DIR: gitdir }),
      timeoutMs: 60_000,
    }).catch(() => undefined);
    this.repo.clearPackCache(repoId);
  }

  private exec(
    args: string[],
    opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
  ): Promise<RpcResult> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const maxBytes = 32 * 1024 * 1024;

    return new Promise((resolve, reject) => {
      const child = spawn(this.gitBin, args, {
        env: opts.env ?? this.buildEnv(),
        windowsHide: true,
      });

      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      let done = false;

      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        child.kill('SIGKILL');
        reject(
          new GitBridgeError(`git ${args[0] || ''} timed out (${timeoutMs}ms)`),
        );
      }, timeoutMs);
      timer.unref?.();

      child.stdout.on('data', (c: Buffer) => {
        outBytes += c.length;
        if (outBytes <= maxBytes) out.push(c);
      });
      child.stderr.on('data', (c: Buffer) => {
        errBytes += c.length;
        if (errBytes <= 64 * 1024) err.push(c);
      });
      child.on('error', (e) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString('utf8'),
        });
      });

      child.stdin.end();
    });
  }
}
