import fs from 'fs';
import path from 'path';

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('dotenv/config');
} catch {
  // In containerized/production environments, env vars are injected directly via process.env
}
import { defineConfig } from 'prisma/config';

// Prisma schemas are maintained authoritatively in prisma/schema/ (modular schemas)
// Do not sync from non-existent or experimental domain directories to prevent accidental file deletion.

export default defineConfig({
  schema: 'prisma/schema',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DIRECT_URL'] || process.env['DATABASE_URL'],
  },
});
