import fs from "fs";
import path from "path";

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv/config");
} catch {
  // In containerized/production environments, env vars are injected directly via process.env
}
import { defineConfig } from "prisma/config";

function syncSchemaDir(srcDir: string, destDir: string) {
  if (!fs.existsSync(srcDir)) return;
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }
  const srcFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith(".prisma"));
  for (const file of srcFiles) {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(destDir, file);
    const srcBuf = fs.readFileSync(srcPath);
    if (!fs.existsSync(destPath) || !fs.readFileSync(destPath).equals(srcBuf)) {
      fs.writeFileSync(destPath, srcBuf);
    }
  }
  const destFiles = fs.readdirSync(destDir).filter((f) => f.endsWith(".prisma"));
  for (const file of destFiles) {
    if (!srcFiles.includes(file)) {
      fs.unlinkSync(path.join(destDir, file));
    }
  }
}

// 1. Automatically mirror library schemas from authoritative domain source: src/modules/library/shared-kernel/prisma
syncSchemaDir(
  path.resolve(__dirname, "src/modules/library/shared-kernel/prisma"),
  path.resolve(__dirname, "prisma/schema/library")
);

// 2. Automatically mirror manuscript schemas from authoritative domain source: src/modules/manuscripts/prisma
syncSchemaDir(
  path.resolve(__dirname, "src/modules/manuscripts/prisma"),
  path.resolve(__dirname, "prisma/schema/manuscripts")
);

export default defineConfig({
  schema: "prisma/schema",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DIRECT_URL"] || process.env["DATABASE_URL"],
  },
});

