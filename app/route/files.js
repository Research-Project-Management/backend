
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Router } from "express";
import { r2 } from "../config/r2.js";
const fileRouter = Router();

fileRouter.post("/presign", async (req, res) => {
  const { fileName } = req.body;
  if (!fileName ) {
    return res.status(400).json({ error: "Missing fileName " });
  }
  const presignedUrl = await getSignedUrl(
    r2,
    new PutObjectCommand({
      Bucket: "rpm-storage",
      Key: fileName,
    }),
    { expiresIn: 3600 } // URL hợp lệ trong 1 giờ
  );
  res.json({ url: presignedUrl });
});

export default fileRouter;
