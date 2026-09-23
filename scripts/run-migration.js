const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const c = new Client({
    connectionString: 'postgresql://postgres:Thanh26102006@127.0.0.1:5433/flux-db?schema=public',
  });
  await c.connect();

  const diffPath = path.resolve(__dirname, 'diff-utf8.sql');
  let sql = fs.readFileSync(diffPath, 'utf8');
  // Strip BOM if present
  if (sql.charCodeAt(0) === 0xFEFF) {
    sql = sql.slice(1);
  }

  console.log('Executing migration SQL...');
  await c.query(sql);
  console.log('Migration executed successfully!');
  await c.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
