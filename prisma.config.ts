import fs from "fs";
import path from "path";

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require("dotenv/config");
} catch {
  // In containerized/production environments, env vars are injected directly via process.env
}
import { defineConfig } from "prisma/config";

// Automatically mirror library schemas from authoritative domain source: src/modules/library/shared-kernel/prisma
const libraryKernelPrismaDir = path.resolve(__dirname, "src/modules/library/shared-kernel/prisma");
const librarySchemaDir = path.resolve(__dirname, "prisma/schema/library");

if (fs.existsSync(libraryKernelPrismaDir)) {
  if (!fs.existsSync(librarySchemaDir)) {
    fs.mkdirSync(librarySchemaDir, { recursive: true });
  }
  const kernelFiles = fs.readdirSync(libraryKernelPrismaDir).filter((f) => f.endsWith(".prisma"));
  for (const file of kernelFiles) {
    const srcPath = path.join(libraryKernelPrismaDir, file);
    const destPath = path.join(librarySchemaDir, file);
    const srcBuf = fs.readFileSync(srcPath);
    if (!fs.existsSync(destPath) || !fs.readFileSync(destPath).equals(srcBuf)) {
      fs.writeFileSync(destPath, srcBuf);
    }
  }
  const destFiles = fs.readdirSync(librarySchemaDir).filter((f) => f.endsWith(".prisma"));
  for (const file of destFiles) {
    if (!kernelFiles.includes(file)) {
      fs.unlinkSync(path.join(librarySchemaDir, file));
    }
  }
}

export default defineConfig({
  schema: "prisma/schema",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env["DIRECT_URL"] || process.env["DATABASE_URL"],
  },
});

