import { eventBus, Events } from "../../../lib/eventBus.js";
import { syncFileToCompilerReliable } from "../../../lib/compiler-sync.js";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2 } from "../../../config/r2.js";

export function bindCompilerToEventBus() {
  eventBus.on(Events.CHILD_PAGE_CREATED, async ({ parentPageId, file, fileBase64, relPath }) => {
    try {
      if (fileBase64) {
        await syncFileToCompilerReliable(parentPageId, relPath, fileBase64);
      } else if (file.url) {
        const key = file.url.split("/api/files/")[1];
        if (key) {
          const r2Resp = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
          const chunks = [];
          for await (const chunk of r2Resp.Body) chunks.push(chunk);
          await syncFileToCompilerReliable(parentPageId, relPath, Buffer.concat(chunks).toString("base64"));
        }
      }
    } catch (err) {
      console.warn("[compiler.subscriber] compiler sync failed:", err.message);
    }
  });
}
