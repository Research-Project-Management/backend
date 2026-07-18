import { z } from "zod";

// --- Page Comment DTOs ---
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

// --- Task Comment DTOs ---
export const CreateTaskCommentDto = {
  body: z.object({
    content: z.string().trim().min(1, "Comment content is required"),
  }),
};

export const UpdateTaskCommentDto = {
  body: z.object({
    content: z.string().trim().min(1).optional(),
  }),
};

export const AddTaskReplyDto = {
  body: z.object({
    content: z.string().trim().min(1, "Reply content is required"),
  }),
};

export const ReactTaskCommentDto = {
  body: z.object({
    emoji: z.string().min(1, "Emoji is required"),
  }),
};
