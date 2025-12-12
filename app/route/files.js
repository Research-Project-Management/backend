import { r2 } from "../config/r2.js";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Router } from "express";
const fileRouter = Router();

fileRouter.post("/presign", async (req, res) => {
  const { filename, contentType } = req.body;
  if (!filename || !contentType) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const params = {
    Bucket: process.env.R2_BUCKET_NAME,
    Key: filename,
    ContentType: contentType,
  };

  try {
    const command = new PutObjectCommand(params);
    const presignedUrl = await getSignedUrl(r2, command, { expiresIn: 3600 });
    res.json({ url: presignedUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

export default fileRouter;
