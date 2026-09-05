import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const connectionString =
  process.env.DATABASE_URL || 'postgresql://localhost:5432/rpm';
const pool = new Pool({ connectionString });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
const ARXIV_FILENAME = /(?:arxiv[:_.\-]*)?(\d{4}\.\d{4,5}(?:v\d+)?)(?:\.pdf)?$/i;

interface ArxivRecord {
  id: string;
  title: string;
  authors: string[];
  year: number | null;
  published: string | null;
  abstract: string;
  keywords: string[];
  doi?: string;
  journalRef?: string;
}

function textBetween(source: string, tag: string): string | null {
  const match = source.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return match?.[1]?.replace(/\s+/g, ' ').trim() || null;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function fetchArxiv(id: string): Promise<ArxivRecord | null> {
  const response = await fetch(
    `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`,
    { headers: { Accept: 'application/atom+xml, application/xml' } },
  );
  if (!response.ok) return null;

  const xml = await response.text();
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/i)?.[1];
  if (!entry || /<title>\s*Error\s*<\/title>/i.test(entry)) return null;

  const published = textBetween(entry, 'published');
  const authorMatches = entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/gi);
  const authors = Array.from(authorMatches, (match) => decodeXml(match[1].trim()));
  const title = textBetween(entry, 'title');
  if (!title) return null;

  const doi = textBetween(entry, 'arxiv:doi');
  const journalRef = textBetween(entry, 'arxiv:journal_ref');
  const keywords = Array.from(
    entry.matchAll(/<category[^>]*term=["']([^"']+)["'][^>]*>/gi),
    (match) => decodeXml(match[1].trim()),
  ).filter(Boolean);

  return {
    id,
    title: decodeXml(title),
    authors,
    year: published ? Number(published.slice(0, 4)) : null,
    published,
    abstract: decodeXml(textBetween(entry, 'summary') || ''),
    keywords,
    doi: doi || undefined,
    journalRef: journalRef ? decodeXml(journalRef) : undefined,
  };
}

export async function backfillArxivMetadata(): Promise<number> {
  const items = await prisma.catalogItem.findMany({
    where: {
      deletedAt: null,
      title: { endsWith: '.pdf', mode: 'insensitive' },
    },
    include: { contributors: true },
  });

  let updated = 0;
  for (const item of items) {
    const match = item.title.match(ARXIV_FILENAME);
    if (!match) continue;

    const arxivId = match[1];
    const metadata = await fetchArxiv(arxivId).catch(() => null);
    if (!metadata) continue;

    await prisma.$transaction(async (tx) => {
      await tx.catalogItem.update({
        where: { id: item.id },
        data: {
          title: metadata.title,
          year: metadata.year,
          publicationDate: metadata.published || undefined,
          publicationTitle: metadata.journalRef || 'arXiv preprint',
          publisher: 'arXiv',
          abstract: metadata.abstract,
          doi: metadata.doi || undefined,
          itemType: 'preprint',
          url: `https://arxiv.org/abs/${arxivId}`,
        },
      });

      if (item.contributors.length === 0 && metadata.authors.length > 0) {
        await tx.catalogContributor.createMany({
          data: metadata.authors.map((fullName, orderIndex) => ({
            catalogItemId: item.id,
            creatorType: 'author',
            fullName,
            firstName: '',
            lastName: fullName,
            orderIndex,
          })),
        });
      }

      const existingIdentifier = await tx.catalogIdentifier.findFirst({
        where: { catalogItemId: item.id, type: 'ARXIV', value: arxivId },
      });
      if (!existingIdentifier) {
        await tx.catalogIdentifier.create({
          data: {
            catalogItemId: item.id,
            type: 'ARXIV',
            value: arxivId,
            canonicalUri: `https://arxiv.org/abs/${arxivId}`,
          },
        });
      }

      for (const keyword of metadata.keywords) {
        const tag = await tx.catalogTag.upsert({
          where: {
            workspaceId_name: {
              workspaceId: item.workspaceId,
              name: keyword,
            },
          },
          update: {},
          create: {
            workspaceId: item.workspaceId,
            name: keyword,
            color: '#3b82f6',
            type: 'imported',
          },
        });
        await tx.catalogItemTag.upsert({
          where: {
            tagId_catalogItemId: {
              tagId: tag.id,
              catalogItemId: item.id,
            },
          },
          update: {},
          create: {
            tagId: tag.id,
            catalogItemId: item.id,
          },
        });
      }
    });

    updated++;
    console.log(`Updated ${item.id} from arXiv:${arxivId}`);
  }

  return updated;
}

if (require.main === module) {
  backfillArxivMetadata()
    .then((count) => console.log(`Backfilled ${count} arXiv item(s).`))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
      await pool.end();
    });
}
