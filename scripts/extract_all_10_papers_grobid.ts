import * as dotenv from 'dotenv';
dotenv.config();

import * as fs from 'fs';
import * as path from 'path';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { GrobidClient } from '../src/modules/library/infra/grobid/grobid.client';
import { PdfProvider } from '../src/modules/library/attachments/providers/pdf.provider';
import { AttachmentExtractionHandler } from '../src/modules/library/attachments/handlers/extraction.handler';

async function main() {
  console.log('======================================================================');
  console.log('⚡ RUNNING AUTONOMOUS PDF EXTRACTION FOR ALL 10 BENCHMARK PAPERS');
  console.log('======================================================================\n');

  const connectionString =
    process.env.DATABASE_URL ||
    'postgresql://postgres:Thanh26102006@127.0.0.1:5433/flux-db?schema=public';
  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  const grobidClient = new GrobidClient();
  const pdfProvider = new PdfProvider(grobidClient);
  const extractionHandler = new AttachmentExtractionHandler(
    prisma as any,
    pdfProvider,
    null as any,
    null as any,
    null as any,
    null as any,
  );

  const papersDir = path.resolve('c:/flux/zotero/papers');
  const papersLinks = JSON.parse(fs.readFileSync('c:/flux/zotero/papers_links.json', 'utf8'));

  try {
    const items = await prisma.item.findMany({
      where: { deletedAt: null },
      take: 10,
    });

    console.log(`Found ${items.length} items in DB to process.\n`);

    for (const [idx, item] of items.entries()) {
      console.log(`[${idx + 1}/${items.length}] Processing: "${item.title}"...`);

      // Find corresponding PDF filename from papers_links
      const metaMatch = papersLinks.find(
        (p: any) =>
          (item.doi && p.doi?.toLowerCase() === item.doi.toLowerCase()) ||
          p.title.toLowerCase() === item.title.toLowerCase() ||
          (p.id && p.id === item.citationKey)
      );

      let pdfPath: string | null = null;
      if (metaMatch?.filename) {
        const candidate = path.join(papersDir, metaMatch.filename);
        if (fs.existsSync(candidate)) pdfPath = candidate;
      }

      if (!pdfPath) {
        // Search directory for matching title keywords
        const files = fs.readdirSync(papersDir);
        const titleKeywords = item.title.toLowerCase().replace(/[^a-z0-9]/g, ' ').split(/\s+/).filter((w) => w.length > 4);
        const found = files.find((f) => titleKeywords.some((k) => f.toLowerCase().includes(k)));
        if (found) pdfPath = path.join(papersDir, found);
      }

      if (!pdfPath || !fs.existsSync(pdfPath)) {
        console.log(`   ⚠️ No PDF found on disk for "${item.title}", skipping.`);
        continue;
      }

      console.log(`   📄 Reading: ${path.basename(pdfPath)}`);
      const buffer = fs.readFileSync(pdfPath);
      const startMs = Date.now();
      const doc = await pdfProvider.extractDocumentFromBuffer(buffer);
      const elapsed = Date.now() - startMs;

      console.log(`   ⚡ Extracted in ${elapsed}ms:`);
      console.log(`      - Abstract: ${doc.metadata.abstract ? doc.metadata.abstract.slice(0, 80) + '...' : '(none)'} (${doc.metadata.abstract?.length || 0} chars)`);
      console.log(`      - Sections: ${doc.sections?.length || 0}`);
      console.log(`      - Figures: ${doc.figures?.length || 0} | Tables: ${doc.tables?.length || 0}`);
      console.log(`      - References: ${doc.references?.length || 0}`);

      // 1. Update Item record with extracted intrinsic metadata
      await prisma.item.update({
        where: { id: item.id },
        data: {
          abstract: doc.metadata.abstract || item.abstract,
          referenceCount: doc.references?.length || item.referenceCount || 0,
          ...(!item.year && doc.metadata.year ? { year: doc.metadata.year } : {}),
          ...(!item.doi && doc.metadata.doi ? { doi: doc.metadata.doi } : {}),
          ...(!item.arxivId && doc.metadata.arxivId ? { arxivId: doc.metadata.arxivId } : {}),
        },
      });

      // 2. Upsert grobid_fulltext record in metadataSourceRecord
      await prisma.metadataSourceRecord.create({
        data: {
          itemId: item.id,
          sourceProvider: 'grobid_fulltext',
          rawPayload: {
            title: doc.metadata.title,
            abstract: doc.metadata.abstract,
            creators: doc.metadata.creators,
            doi: doc.metadata.doi,
            arxivId: doc.metadata.arxivId,
            year: doc.metadata.year,
            keywords: doc.metadata.keywords,
            sections: doc.sections ?? [],
            figures: doc.figures ?? [],
            tables: doc.tables ?? [],
            formulas: doc.formulas ?? [],
            references: doc.references ?? [],
            sectionCount: doc.sections?.length ?? 0,
            figureCount: doc.figures?.length ?? 0,
            tableCount: doc.tables?.length ?? 0,
            formulaCount: doc.formulas?.length ?? 0,
            referenceCount: doc.references?.length ?? 0,
          } as any,
        },
      });

      // 3. Link citations
      if (doc.references && doc.references.length > 0) {
        const scopeId = item.projectId || item.userId;
        await extractionHandler.linkInLibraryCitations(scopeId, item.id, doc.references);
      }
    }

    console.log('\n======================================================================');
    console.log('✅ ALL 10 BENCHMARK PAPERS EXTRACTED & UPDATED IN DATABASE');
    console.log('======================================================================');
  } catch (err) {
    console.error('Extraction error:', err);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main();
