import { z } from "zod";

export const CreateWorkspaceDto = {
  body: z.object({
    name: z.string().trim().min(1, "Workspace name is required"),
    url: z.string().optional(),
    color: z.string().optional(),
    avatar: z.string().optional(),
    companySize: z.string().optional(),
  }),
};

export const UpdateWorkspaceDto = {
  body: z.object({
    name: z.string().trim().min(1, "Workspace name cannot be empty").optional(),
    avatar: z.string().optional(),
    companySize: z.string().optional(),
  }),
};

export const AddWorkspaceMemberDto = {
  body: z.object({
    userId: z.string().min(1, "User ID is required").optional(),
    roleId: z.string().optional(),
    role: z.string().optional(),
    newRole: z.string().optional(),
  }),
};

export const UpdateWorkspaceMemberDto = {
  body: z.object({
    roleId: z.string().optional(),
    role: z.string().optional(),
    newRole: z.string().optional(),
  }),
};

export const JoinWorkspaceDto = {
  body: z.object({
    inviteCode: z.string().min(1, "Invite code is required"),
  }),
};
