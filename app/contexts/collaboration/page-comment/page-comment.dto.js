import { z } from "zod";

export const CreatePageCommentDto = {
  body: z.object({
    content: z.string().trim().min(1, "Comment content is required"),
    resolved: z.boolean().optional(),
    quote: z.string().optional(),
    textRange: z.any().optional(),
  }),
};

export const UpdatePageCommentDto = {
  body: z.object({
    content: z.string().trim().min(1).optional(),
    resolved: z.boolean().optional(),
  }),
};

export const AddPageReplyDto = {
  body: z.object({
    content: z.string().trim().min(1, "Reply content is required"),
  }),
};
