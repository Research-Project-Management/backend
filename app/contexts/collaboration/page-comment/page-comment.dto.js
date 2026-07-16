import { z } from "zod";

export const CreatePageCommentDto = {
  body: z.object({
    content: z.string().trim().min(1, "Comment content is required"),
    status: z.enum(["open", "resolved"]).optional(),
    line: z.number().optional().nullable(),
    lineEnd: z.number().optional().nullable(),
  }),
};

export const UpdatePageCommentDto = {
  body: z.object({
    content: z.string().trim().min(1).optional(),
    status: z.enum(["open", "resolved"]).optional(),
  }),
};

export const AddPageReplyDto = {
  body: z.object({
    content: z.string().trim().min(1, "Reply content is required"),
  }),
};
