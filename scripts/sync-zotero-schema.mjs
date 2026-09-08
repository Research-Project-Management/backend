/**
 * Sync official schema from api.zotero.org/schema into Flux codebase.
 * Usage: node scripts/sync-zotero-schema.mjs
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ZOTERO_SCHEMA_URL = 'https://api.zotero.org/schema';

async function syncSchema() {
  console.log(`[Zotero Sync] Fetching official schema from ${ZOTERO_SCHEMA_URL}...`);
  const response = await fetch(ZOTERO_SCHEMA_URL, {
    headers: {
      'User-Agent': 'FluxResearchPlatform/1.0 (https://flux.study)',
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Zotero schema: HTTP ${response.status} ${response.statusText}`);
  }

  const schema = await response.json();

  if (!schema || typeof schema !== 'object' || !Array.isArray(schema.itemTypes)) {
    throw new Error('Invalid Zotero schema payload: itemTypes array is missing.');
  }

  console.log(`[Zotero Sync] Schema version ${schema.version} retrieved successfully.`);
  console.log(`[Zotero Sync] Found ${schema.itemTypes.length} item types.`);

  const backendDestDir = path.resolve(__dirname, '../src/modules/library/types/data');
  const backendDestPath = path.join(backendDestDir, 'zotero-schema.json');

  if (!fs.existsSync(backendDestDir)) {
    fs.mkdirSync(backendDestDir, { recursive: true });
  }

  const jsonContent = JSON.stringify(schema, null, 2);
  fs.writeFileSync(backendDestPath, jsonContent, 'utf-8');
  console.log(`[Zotero Sync] Written to backend: ${backendDestPath}`);

  const frontendDestDir = path.resolve(__dirname, '../../frontend/src/features/workspaces/library/schemas');
  const frontendDestPath = path.join(frontendDestDir, 'zotero-schema.json');

  if (fs.existsSync(frontendDestDir)) {
    fs.writeFileSync(frontendDestPath, jsonContent, 'utf-8');
    console.log(`[Zotero Sync] Written to frontend: ${frontendDestPath}`);
  }

  console.log('[Zotero Sync] Synchronization completed successfully!');
}

syncSchema().catch((err) => {
  console.error('[Zotero Sync] Error:', err);
  process.exit(1);
});
