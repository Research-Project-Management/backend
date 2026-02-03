import mongoose from "mongoose";

const workspaceMemberSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  role: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Role",
    required: true,
  },
  // Legacy role field for backward compatibility
  legacyRole: {
    type: String,
    enum: ["owner", "admin", "member"],
  },
  joinedAt: { type: Date, default: Date.now },
});

const workspaceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    members: [workspaceMemberSchema],
    url: { type: String, required: true, unique: true },
    avatar: { type: String, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    settings: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true },
);

// Indexes for performance optimization
workspaceSchema.index({ url: 1 });
workspaceSchema.index({ "members.user": 1 });
workspaceSchema.index({ createdBy: 1 });

export default mongoose.model("Workspace", workspaceSchema);
