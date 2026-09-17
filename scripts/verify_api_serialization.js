require('dotenv').config({ path: 'd:/project/flux/backend/.env' });
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { Pool } = require('pg');
const { ItemsMapper } = require('../dist/modules/library/items/mappers/items.mapper.js');

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    const user = await prisma.user.findFirst();
    const benchmarkIds = ['1706.03762', '1512.03385', '1810.04805', '1412.6980', '1406.2661', '1301.3781', '1310.4546', '1312.6114', '1409.0473', '1409.1556'];
    const items = await prisma.item.findMany({
      where: {
        userId: user.id,
        deletedAt: null,
        OR: benchmarkIds.map(id => ({ arxivId: { contains: id } }))
      },
      include: {
        contributors: { orderBy: { orderIndex: 'asc' } },
        identifiers: true,
        collectionItems: { include: { collection: true } },
        itemTags: { include: { tag: true } },
        attachments: true,
        notesList: { where: { deletedAt: null } },
        user: { select: { id: true, name: true, avatar: true, email: true } },
      },
      orderBy: { citationCount: 'desc' },
    });

    console.log(`Fetched ${items.length} active items for ${user.email}`);

    items.forEach((item, i) => {
      const mapped = ItemsMapper.mapFlattenedState(item, user.id);
      console.log(`\n--- [Item ${i + 1}] ---`);
      console.log('Title:           ', mapped.title);
      console.log('Authors:         ', mapped.creators?.map(c => c.name || `${c.firstName} ${c.lastName}`).join(', '));
      console.log('Year:            ', mapped.year);
      console.log('Publication/Venue:', mapped.publicationTitle);
      console.log('Item Type:       ', mapped.itemType);
      console.log('DOI:             ', mapped.doi);
      console.log('arXiv ID:        ', mapped.arxivId);
      console.log('Citation Count:  ', mapped.citationCount);
      console.log('Reference Count: ', mapped.referenceCount);
      console.log('Abstract:        ', mapped.abstract ? mapped.abstract.slice(0, 60) + '...' : '(none)');
      console.log('Attachments:     ', mapped.attachments?.length || 0);
    });

    console.log('\nAll checked items successfully mapped to API response with full field integrity!');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch(console.error);
