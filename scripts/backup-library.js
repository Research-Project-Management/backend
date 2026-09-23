const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const c = new Client({
    connectionString: 'postgresql://postgres:Thanh26102006@127.0.0.1:5433/flux-db?schema=public',
  });
  await c.connect();
  const backupDir = path.resolve(__dirname, '../../brain/2e546606-062c-4cb2-ac77-3fbb625a512a/scratch');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }
  const papers = (await c.query('SELECT * FROM papers')).rows;
  const contributors = (await c.query('SELECT * FROM contributors')).rows;
  const collection_items = (await c.query('SELECT * FROM collection_items')).rows;

  const backupFile = path.join(backupDir, 'library_backup.json');
  fs.writeFileSync(backupFile, JSON.stringify({ papers, contributors, collection_items }, null, 2));
  console.log('Saved backup to', backupFile);
  console.log(`Backed up: ${papers.length} papers, ${contributors.length} contributors, ${collection_items.length} collection items.`);
  await c.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
