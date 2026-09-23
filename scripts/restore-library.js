const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const c = new Client({
    connectionString: 'postgresql://postgres:Thanh26102006@127.0.0.1:5433/flux-db?schema=public',
  });
  await c.connect();

  const backupDir = path.resolve(__dirname, '../../brain/2e546606-062c-4cb2-ac77-3fbb625a512a/scratch');
  const backupFile = path.join(backupDir, 'library_backup.json');
  if (!fs.existsSync(backupFile)) {
    console.error('Backup file not found at', backupFile);
    process.exit(1);
  }

  const { papers, contributors, collection_items } = JSON.parse(fs.readFileSync(backupFile, 'utf8'));

  for (const p of papers) {
    // Check if item already exists
    const exists = await c.query('SELECT id FROM items WHERE id = $1', [p.id]);
    if (exists.rows.length === 0) {
      await c.query(
        `INSERT INTO items (
          id, title, type, year, citation_key, doi, publication_title, abstract, url,
          metadata, user_id, project_id, version, deleted_at, created_at, updated_at,
          has_file, attachment_count, note_count, first_author
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9,
          $10, $11, $12, $13, $14, $15, $16,
          $17, $18, $19, $20
        )`,
        [
          p.id,
          p.title,
          p.item_type || 'journalArticle',
          p.year,
          p.citation_key,
          p.doi,
          p.publication_title,
          p.abstract,
          p.url,
          p.extra ? JSON.stringify({ extra: p.extra }) : '{}',
          p.user_id,
          p.project_id,
          p.version || 1,
          p.deleted_at,
          p.created_at,
          p.updated_at,
          false,
          0,
          0,
          p.first_author || null,
        ]
      );
      console.log('Inserted item:', p.title);
    }
  }

  for (const contrib of contributors) {
    const exists = await c.query('SELECT id FROM contributors WHERE id = $1', [contrib.id]);
    if (exists.rows.length === 0) {
      await c.query(
        `INSERT INTO contributors (
          id, item_id, creator_type, field_mode, first_name, last_name, full_name, orcid, order_index, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
        )`,
        [
          contrib.id,
          contrib.item_id,
          contrib.creator_type || 'author',
          contrib.field_mode || 0,
          contrib.first_name || '',
          contrib.last_name || '',
          contrib.full_name,
          contrib.orcid || null,
          contrib.order_index || 0,
          contrib.created_at,
        ]
      );
      console.log('Inserted contributor:', contrib.full_name);
    }
  }

  for (const ci of collection_items) {
    const exists = await c.query('SELECT collection_id FROM collection_items WHERE collection_id = $1 AND item_id = $2', [ci.collection_id, ci.item_id]);
    if (exists.rows.length === 0) {
      await c.query(
        `INSERT INTO collection_items (collection_id, item_id, sort_order, added_at)
         VALUES ($1, $2, $3, $4)`,
        [ci.collection_id, ci.item_id, ci.sort_order || 0, ci.added_at]
      );
      console.log('Inserted collection_item:', ci.collection_id, ci.item_id);
    }
  }

  console.log('Restore completed successfully.');
  await c.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
