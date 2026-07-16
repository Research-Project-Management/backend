import { z } from "zod";

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
