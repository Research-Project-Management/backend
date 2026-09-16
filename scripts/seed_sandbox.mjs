import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsonPath = path.resolve(__dirname, '../../zotero/papers_links.json');
const papersDir = path.resolve(__dirname, '../../zotero/papers');

const { Pool } = pg;
const connectionString =
  process.env.DATABASE_URL ||
  'postgresql://postgres:Thanh26102006@127.0.0.1:5433/flux-db?schema=public';

const pool = new Pool({ connectionString });

async function seed() {
  const client = await pool.connect();
  console.log('Connected to PostgreSQL for sandbox seeding...');

  try {
    // 1. Target user
    const userRes = await client.query('SELECT id, name, email FROM users ORDER BY created_at ASC LIMIT 1');
    if (userRes.rows.length === 0) {
      throw new Error('No user found in database. Please register a user first.');
    }
    const user = userRes.rows[0];
    console.log(`Target user: ${user.name || user.email} (${user.id})`);

    // 2. Collection
    let collectionId;
    const collRes = await client.query(
      'SELECT id FROM collections WHERE user_id = $1 AND name = $2 AND deleted_at IS NULL LIMIT 1',
      [user.id, 'Zotero 20 Papers Benchmark']
    );

    if (collRes.rows.length > 0) {
      collectionId = collRes.rows[0].id;
      console.log(`Found existing collection: Zotero 20 Papers Benchmark (${collectionId})`);
    } else {
      collectionId = crypto.randomUUID();
      await client.query(
        `INSERT INTO collections (id, user_id, name, color, icon, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
        [collectionId, user.id, 'Zotero 20 Papers Benchmark', '#10b981', 'bookmark']
      );
      console.log(`Created collection: Zotero 20 Papers Benchmark (${collectionId})`);
    }

    // 3. Load papers_links.json
    const papers = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    console.log(`Loaded ${papers.length} papers from papers_links.json\n`);

    let inserted = 0;
    let updated = 0;

    for (const p of papers) {
      const existing = await client.query(
        'SELECT id FROM papers WHERE user_id = $1 AND (doi = $2 OR citation_key = $3) AND deleted_at IS NULL LIMIT 1',
        [user.id, p.doi, p.id]
      );

      let itemId;
      if (existing.rows.length > 0) {
        itemId = existing.rows[0].id;
        await client.query(
          `UPDATE papers
           SET title = $1, year = $2, publication_title = $3, url = $4, updated_at = NOW()
           WHERE id = $5`,
          [p.title, p.year, p.venue, p.landingUrl, itemId]
        );
        updated++;
      } else {
        itemId = crypto.randomUUID();
        await client.query(
          `INSERT INTO papers (
            id, user_id, title, year, doi, publication_title, url, citation_key, item_type,
            open_access_pdf_url, extra, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), NOW())`,
          [
            itemId,
            user.id,
            p.title,
            p.year,
            p.doi,
            p.venue,
            p.landingUrl,
            p.id,
            'journalArticle',
            p.pdfUrl,
            JSON.stringify({ authors: p.authors }),
          ]
        );
        inserted++;
      }

      // Link to collection
      await client.query(
        `INSERT INTO collection_items (id, collection_id, item_id, added_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (collection_id, item_id) DO NOTHING`,
        [crypto.randomUUID(), collectionId, itemId]
      );

      // Check local PDF file attachment
      const pdfFilePath = path.join(papersDir, p.filename);
      if (fs.existsSync(pdfFilePath)) {
        const stat = fs.statSync(pdfFilePath);
        const attachRes = await client.query(
          'SELECT id FROM attachments WHERE item_id = $1 AND (filename = $2 OR attachment_type = $3) LIMIT 1',
          [itemId, p.filename, 'primary_pdf']
        );

        if (attachRes.rows.length === 0) {
          const attachId = crypto.randomUUID();
          await client.query(
            `INSERT INTO attachments (
              id, item_id, name, filename, size, mime_type, url, attachment_type,
              extraction_status, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'COMPLETED', NOW(), NOW())`,
            [
              attachId,
              itemId,
              p.title,
              p.filename,
              stat.size,
              'application/pdf',
              p.pdfUrl,
              'primary_pdf',
            ]
          );
        }
      }
    }

    console.log(`\n======================================================`);
    console.log(`✅ Sandbox Database Seed Complete!`);
    console.log(`   - Inserted: ${inserted} papers`);
    console.log(`   - Updated:  ${updated} papers`);
    console.log(`   - Total in collection: ${papers.length} papers`);
    console.log(`   - Collection ID: ${collectionId}`);
    console.log(`======================================================\n`);
  } catch (err) {
    console.error('Failed to seed sandbox:', err);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
