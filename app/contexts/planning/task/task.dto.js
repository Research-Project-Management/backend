import { z } from "zod";

const ChecklistItemSchema = z.object({
  title: z.string().trim().min(1),
  completed: z.boolean().default(false),
  assigneeId: z.string().optional().nullable(),
  dueDate: z.string().datetime().optional().or(z.date().optional()),
});

const ChecklistSchema = z.object({
  title: z.string().trim().min(1),
  items: z.array(ChecklistItemSchema).default([]),
});

export const CreateTaskDto = {
  body: z.object({
    title: z.string().trim().min(1, "Task title is required"),
    content: z.string().optional(),
    description: z.string().optional(),
    columnId: z.string().trim().min(1, "Column ID is required"),
    assignee: z.string().optional().nullable(),
    startDate: z.string().datetime().optional().or(z.date().optional()),
    dueDate: z.string().datetime().optional().or(z.date().optional()),
    priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
    cycle: z.string().optional().nullable(),
    parentTask: z.string().optional().nullable(),
    labels: z.array(z.string()).optional(),
    checklists: z.array(ChecklistSchema).optional(),
  }),
};

export const UpdateTaskDto = {
  body: z.object({
    title: z.string().trim().min(1).optional(),
    content: z.string().optional(),
    description: z.string().optional(),
    columnId: z.string().trim().min(1).optional(),
    assignee: z.string().optional().nullable(),
    startDate: z.string().datetime().optional().or(z.date().optional()),
    dueDate: z.string().datetime().optional().or(z.date().optional()),
    priority: z.enum(["urgent", "high", "medium", "low", "none"]).optional(),
    cycle: z.string().optional().nullable(),
    parentTask: z.string().optional().nullable(),
    labels: z.array(z.string()).optional(),
    checklists: z.array(ChecklistSchema).optional(),
    completed: z.boolean().optional(),
    rank: z.number().optional(),
  }),
};

export const AssignTaskDto = {
  body: z.object({
    assignee: z.string().min(1, "Assignee ID is required"),
  }),
};

export const ReorderTaskDto = {
  body: z.object({
    sourceIndex: z.number(),
    destinationIndex: z.number(),
    sourceColumnId: z.string().min(1),
    destinationColumnId: z.string().min(1),
  }),
};
