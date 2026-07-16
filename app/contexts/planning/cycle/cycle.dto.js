import { z } from "zod";

export const CreateCycleDto = {
  body: z.object({
    name: z.string().trim().min(1, "Cycle name is required"),
    description: z.string().optional(),
    startDate: z.string().datetime().optional().or(z.date().optional()),
    endDate: z.string().datetime().optional().or(z.date().optional()),
    status: z.enum(["planned", "active", "completed", "cancelled"]).optional(),
    phase: z.enum([
      "topic_selection",
      "literature_review",
      "methodology",
      "data_collection",
      "data_analysis",
      "writing",
      "review_revision",
      "submission",
      "custom",
    ]).optional(),
  }),
};

export const UpdateCycleDto = {
  body: z.object({
    name: z.string().trim().min(1, "Cycle name cannot be empty").optional(),
    description: z.string().optional(),
    startDate: z.string().datetime().optional().or(z.date().optional()),
    endDate: z.string().datetime().optional().or(z.date().optional()),
    status: z.enum(["planned", "active", "completed", "cancelled"]).optional(),
    phase: z.enum([
      "topic_selection",
      "literature_review",
      "methodology",
      "data_collection",
      "data_analysis",
      "writing",
      "review_revision",
      "submission",
      "custom",
    ]).optional(),
  }),
};

export const AddCycleTaskDto = {
  body: z.object({
    taskId: z.string().min(1, "Task ID is required"),
  }),
};
