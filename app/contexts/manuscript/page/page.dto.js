import { z } from "zod";

export const CreatePageDto = {
  body: z.object({
    title: z.string().trim().min(1, "Page title is required"),
    content: z.any().optional(),
    parentPage: z.string().optional().nullable(),
  }),
};

export const UpdatePageDto = {
  body: z.object({
    title: z.string().trim().min(1).optional(),
    content: z.any().optional(),
    mainFile: z.string().optional().nullable(),
    status: z.enum(["draft", "published", "archived"]).optional(),
    pdfThumbnail: z.string().optional().nullable(),
  }),
};
