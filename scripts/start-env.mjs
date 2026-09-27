#!/usr/bin/env node

/**
 * Flux Backend Environment Launcher
 * 
 * Auto-detects VPS (Production) vs Local Dev:
 * - On VPS: Automatically starts all services (including backend and worker) inside Docker.
 * - On Local Dev: Starts only infrastructure in Docker (DB, Redis, Grobid, Zotero TS),
 *   stops any Docker container holding port 3000, leaving port 3000 free for `pnpm run dev`.
 */

import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';

const args = process.argv.slice(2);
const forceProd = args.includes('--prod') || args.includes('--vps');
const forceDev = args.includes('--dev') || args.includes('--local');

function isVpsEnvironment() {
  if (forceProd) return true;
  if (forceDev) return false;

  // 1. Explicit environment variables
  if (process.env.NODE_ENV === 'production') return true;
  if (process.env.COMPOSE_PROFILES?.includes('prod')) return true;
  if (process.env.IS_VPS === 'true') return true;

  // 2. Check VPS path
  const cwd = process.cwd();
  if (cwd.startsWith('/opt/flux') || fs.existsSync('/opt/flux/backend')) {
    return true;
  }

  // 3. Check if .env specifies production
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      if (/^NODE_ENV\s*=\s*production/m.test(content)) return true;
      if (/^COMPOSE_PROFILES\s*=.*prod/m.test(content)) return true;
    } catch (_) {}
  }

  return false;
}

function runCommand(cmd, options = {}) {
  try {
    return execSync(cmd, { stdio: 'inherit', ...options });
  } catch (err) {
    if (options.ignoreError) return null;
    throw err;
  }
}

function getCommandOutput(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) {
    return '';
  }
}

function checkPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      resolve(err.code !== 'EADDRINUSE');
    });
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}

async function main() {
  const isVps = isVpsEnvironment();

  console.log('\n==============================================================');
  console.log(`[Flux Backend Orchestrator] Target: ${isVps ? 'VPS (Production)' : 'Local Dev'}`);
  console.log('==============================================================\n');

  if (isVps) {
    console.log('🚀 Running in VPS Production Mode:');
    console.log('   - Starting ALL services in Docker (DB, Redis, Grobid, Zotero, Backend, Worker)...');

    // Run docker compose with prod profile
    runCommand('docker compose --profile prod up -d');

    console.log('\n✅ Docker stack up with production profile.');
    console.log('   - Database: 5433 (internal 5432)');
    console.log('   - Redis:    6379');
    console.log('   - GROBID:   8070');
    console.log('   - Zotero:   1969');
    console.log('   - Backend:  Port 3000 (running in container flux_backend)');
    console.log('   - Worker:   running in container flux_backend_worker');

    console.log('\n🔍 Verifying running containers:');
    runCommand('docker compose ps');

    console.log('\n🎉 Production deployment complete!\n');
  } else {
    console.log('💻 Running in Local Development Mode:');
    console.log('   - Checking if Docker backend container (port 3000) is running...');

    // Only stop flux_backend to avoid port 3000 collision; flux_backend_worker stays in Docker!
    const runningContainers = getCommandOutput('docker ps --format "{{.Names}}"');
    if (runningContainers.split('\n').map(s => s.trim()).includes('flux_backend')) {
      console.log('   - Stopping Docker flux_backend to free port 3000...');
      runCommand('docker stop flux_backend', { ignoreError: true });
    }

    console.log('   - Starting Docker services (db, redis, grobid, translator, worker, clsi)...');
    runCommand('docker compose up -d db redis grobid translator worker clsi');

    // Ensure flux_clsi is running on port 3013
    const allContainers = getCommandOutput('docker ps -a --format "{{.Names}}"');
    const containerNames = allContainers.split('\n').map(s => s.trim());
    if (containerNames.includes('flux_clsi')) {
      const runningContainersNow = getCommandOutput('docker ps --format "{{.Names}}"');
      if (!runningContainersNow.split('\n').map(s => s.trim()).includes('flux_clsi')) {
        console.log('   - Starting flux_clsi container...');
        runCommand('docker start flux_clsi', { ignoreError: true });
      }
    }

    console.log('\n🔍 Docker Services Status:');
    runCommand('docker compose ps db redis grobid translator worker clsi');

    const port3000Free = await checkPortFree(3000);

    console.log('\n==============================================================');
    console.log('✨ Local Dev Environment Ready!');
    console.log('   - PostgreSQL:     127.0.0.1:5433 (Docker)');
    console.log('   - Redis:          127.0.0.1:6379 (Docker)');
    console.log('   - GROBID:         127.0.0.1:8070 (Docker)');
    console.log('   - Zotero TS:      127.0.0.1:1969 (Docker)');
    console.log('   - CLSI Compiler:  127.0.0.1:3013 (Docker)');
    console.log('   - BullMQ Worker:  flux_backend_worker (Docker container)');
    if (port3000Free) {
      console.log('   - Backend Port:   Port 3000 is FREE for your local NestJS backend');
    } else {
      console.log('   - Backend Port:   Port 3000 is ACTIVE (local backend process is running)');
    }
    console.log('--------------------------------------------------------------');
    console.log('👉 To run your backend locally:');
    console.log('   pnpm run dev');
    console.log('==============================================================\n');
  }
}

main().catch((err) => {
  console.error('\n❌ Execution error:', err.message);
  process.exit(1);
});
