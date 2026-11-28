/**
 * Deterministic OpenAPI 3.0 specification exporter & freshness gate.
 * Loads compiled `dist/` under plain Node so NestJS decorator metadata matches production.
 *
 * Usage:
 *   pnpm run build && pnpm run openapi:export   # writes openapi/openapi.json
 *   pnpm run build && pnpm run verify:openapi   # exits 1 if committed openapi/openapi.json is stale
 */
import 'reflect-metadata';
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

async function main(): Promise<void> {
  const repoRoot = resolve(__dirname, '..', '..');
  const distAppPath = resolve(repoRoot, 'dist', 'app.module.js');
  const distSwaggerPath = resolve(repoRoot, 'dist', 'core', 'http', 'setup', 'swagger.setup.js');

  if (!existsSync(distAppPath) || !existsSync(distSwaggerPath)) {
    console.error('✖ Missing compiled dist/ artifacts. Run `pnpm run build` before exporting OpenAPI.');
    process.exit(1);
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppModule } = require(distAppPath);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { buildSwaggerDocument } = require(distSwaggerPath);

  if (typeof buildSwaggerDocument !== 'function') {
    console.error('✖ dist/core/http/setup/swagger.setup.js is stale (missing buildSwaggerDocument). Run `pnpm run build`.');
    process.exit(1);
  }

  const checkOnly = process.argv.includes('--check');
  const outPath = resolve(repoRoot, 'openapi', 'openapi.json');

  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );

  try {
    const document = buildSwaggerDocument(app);
    const serialized = `${JSON.stringify(sortKeysDeep(document), null, 2)}\n`;

    if (checkOnly) {
      if (!existsSync(outPath)) {
        console.error('✖ verify:openapi failed: openapi/openapi.json does not exist. Run `pnpm run openapi:export`.');
        process.exit(1);
      }
      const existing = readFileSync(outPath, 'utf8');
      if (existing !== serialized) {
        console.error('✖ verify:openapi failed: openapi/openapi.json is out of date. Run `pnpm run openapi:export` and commit the result.');
        process.exit(1);
      }
      console.log('✔ verify:openapi passed: openapi/openapi.json matches current controllers/DTOs.');
      return;
    }

    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, serialized, 'utf8');
    console.log(`✔ Exported OpenAPI spec to ${outPath} (${Object.keys(document.paths).length} paths).`);
  } finally {
    await app.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error('✖ OpenAPI export failed:', err);
    process.exit(1);
  });
