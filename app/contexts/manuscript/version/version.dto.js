import { z } from "zod";

export const CreateVersionDto = {
  body: z.object({
    content: z.string().optional(),
    title: z.string().optional(),
    label: z.string().optional(),
    eventType: z.enum([
      "manual_save",
      "auto_save",
      "file_created",
      "file_deleted",
      "asset_uploaded",
      "asset_deleted",
    ]).optional(),
    fileName: z.string().optional(),
  }),
};
