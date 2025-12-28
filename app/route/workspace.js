import { Router } from "express";
import WorkspaceModel from "../schema/workspace.js";
import {
  isAuthenticated,
  checkWorkspaceRole,
} from "../middleware/checkWorkspaceRole.js";

const workspaceRouter = Router();

// Lấy tất cả workspace của user
workspaceRouter.get("/", isAuthenticated, async (req, res) => {
  const workspaces = await WorkspaceModel.find({
    "members.user": req.user._id,
  });
  res.json({ workspaces });
});

// Tạo workspace mới (user tạo sẽ là owner)
workspaceRouter.post("/", isAuthenticated, async (req, res) => {
  const { name, color, avatar } = req.body;
  const newWorkspace = new WorkspaceModel({
    name,
    color,
    avatar: avatar || "",
    members: [{ user: req.user._id, role: "owner" }],
    createdBy: req.user._id,
  });
  await newWorkspace.save();
  res.status(201).json({ workspace: newWorkspace });
});

// Lấy chi tiết workspace (member trở lên)
workspaceRouter.get(
  "/:id",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin", "member"),
  async (req, res) => {
    const workspace = await req.workspace.populate("members.user");
    res.json({ workspace, yourRole: req.workspaceRole });
  }
);

// Cập nhật workspace (admin trở lên)
workspaceRouter.put(
  "/:id",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin"),
  async (req, res) => {
    const { name } = req.body;
    const workspace = await WorkspaceModel.findByIdAndUpdate(
      req.params.id,
      { name },
      { new: true }
    );
    res.json({ workspace });
  }
);

// Thêm member (admin trở lên)
workspaceRouter.put(
  "/:id/add-member",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin"),
  async (req, res) => {
    const { userId, role = "member" } = req.body;

    // Admin không thể thêm owner hoặc admin khác
    if (req.workspaceRole === "admin" && ["owner", "admin"].includes(role)) {
      return res.status(403).json({ error: "Cannot add owner or admin" });
    }

    const workspace = req.workspace;

    // Kiểm tra đã là member chưa
    const existingMember = workspace.members.find(
      (m) => m.user.toString() === userId
    );
    if (existingMember) {
      return res.status(400).json({ error: "User already a member" });
    }

    workspace.members.push({ user: userId, role });
    await workspace.save();
    res.json({ workspace });
  }
);

// Cập nhật role member (owner hoặc admin)
workspaceRouter.put(
  "/:id/update-member-role",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin"),
  async (req, res) => {
    const { userId, newRole } = req.body;
    const workspace = req.workspace;

    // Chỉ owner mới đổi được role thành admin/owner
    if (req.workspaceRole !== "owner" && ["owner", "admin"].includes(newRole)) {
      return res
        .status(403)
        .json({ error: "Only owner can assign admin/owner role" });
    }

    const member = workspace.members.find((m) => m.user.toString() === userId);
    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    member.role = newRole;
    await workspace.save();
    res.json({ workspace });
  }
);

// Xóa member (admin trở lên, không thể xóa owner)
workspaceRouter.put(
  "/:id/remove-member",
  isAuthenticated,
  checkWorkspaceRole("owner", "admin"),
  async (req, res) => {
    const { userId } = req.body;
    const workspace = req.workspace;

    const memberToRemove = workspace.members.find(
      (m) => m.user.toString() === userId
    );

    if (!memberToRemove) {
      return res.status(404).json({ error: "Member not found" });
    }

    // Không thể xóa owner
    if (memberToRemove.role === "owner") {
      return res.status(403).json({ error: "Cannot remove owner" });
    }

    // Admin không thể xóa admin khác
    if (req.workspaceRole === "admin" && memberToRemove.role === "admin") {
      return res
        .status(403)
        .json({ error: "Admin cannot remove another admin" });
    }

    workspace.members = workspace.members.filter(
      (m) => m.user.toString() !== userId
    );
    await workspace.save();
    res.json({ workspace });
  }
);

// Xóa workspace (chỉ owner)
workspaceRouter.delete(
  "/:id",
  isAuthenticated,
  checkWorkspaceRole("owner"),
  async (req, res) => {
    await WorkspaceModel.findByIdAndDelete(req.params.id);
    res.status(204).end();
  }
);

export default workspaceRouter;
