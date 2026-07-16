import { z } from "zod";

export const CreateProjectDto = {
  body: z.object({
    name: z.string().trim().min(1, "Project name is required"),
    description: z.string().optional(),
    color: z.string().optional(),
    avatar: z.string().optional(),
  }),
};

export const UpdateProjectDto = {
  body: z.object({
    name: z.string().trim().min(1, "Project name cannot be empty").optional(),
    description: z.string().optional(),
    color: z.string().optional(),
    avatar: z.string().optional(),
  }),
};

export const AddProjectMemberDto = {
  body: z.object({
    userId: z.string().min(1, "User ID is required").optional(),
    role: z.string().optional(),
    newRole: z.string().optional(),
  }),
};

export const UpdateProjectMemberDto = {
  body: z.object({
    role: z.string().optional(),
    newRole: z.string().optional(),
  }),
};

export const AddColumnDto = {
  body: z.object({
    title: z.string().trim().min(1, "Column title is required").default("New Column"),
    color: z.string().default("#6b7280"),
  }),
};

export const UpdateColumnDto = {
  body: z.object({
    title: z.string().trim().min(1, "Column title cannot be empty").optional(),
    color: z.string().optional(),
  }),
};
