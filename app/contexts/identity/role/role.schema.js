import mongoose from "mongoose";

// Permission schema để định nghĩa các quyền cụ thể
const permissionSchema = new mongoose.Schema({
  resource: {
    type: String,
    required: true,
    enum: [
      "workspace",
      "project",
      "task",
      "page",
      "file",
      "sticky",
      "member",
      "settings",
      "role",
    ],
  },
  actions: {
    type: [String],
    enum: ["create", "read", "update", "delete", "manage", "invite", "export"],
    default: [],
  },
});

// Role schema - roles có thể được tạo cho workspace hoặc project
const roleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: "",
    },
    // Loại role: workspace-level hoặc project-level
    type: {
      type: String,
      enum: ["workspace", "project"],
      required: true,
    },
    // workspace hoặc project mà role này thuộc về
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Workspace',
      required: true,
    },
    projectId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Project',
      default: null,
    },
    // Danh sách permissions
    permissions: [permissionSchema],
    // Có phải là role mặc định không (owner, admin, member)
    isDefault: {
      type: Boolean,
      default: false,
    },
    // Có phải là role hệ thống (không thể xóa/sửa)
    isSystem: {
      type: Boolean,
      default: false,
    },
    // Màu sắc để hiển thị
    color: {
      type: String,
      default: "#6366f1",
    },
    createdById: {
      type: mongoose.Schema.Types.ObjectId, ref: 'User',
    },
  },
  { timestamps: true },
);

// Index để tìm kiếm nhanh
roleSchema.index({ workspaceId: 1, type: 1 });
roleSchema.index({ projectId: 1 });
roleSchema.index({ name: 1, workspaceId: 1 });

export default mongoose.model("Role", roleSchema);
