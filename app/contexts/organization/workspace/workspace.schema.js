import mongoose from "mongoose";
import crypto from "crypto";

const workspaceMemberSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: {
    type: String,
    enum: ['owner', 'admin', 'member', 'viewer'],
    default: 'member',
  },
  joinedAt: { type: Date, default: Date.now },
});

const workspaceSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    members: [workspaceMemberSchema],
    url: { type: String, required: true, unique: true },
    avatar: { type: String, default: "" },
    companySize: { type: String, default: "" },
    createdById: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    settings: { type: mongoose.Schema.Types.Mixed, default: {} },
    inviteCode: {
      type: String,
      unique: true,
      sparse: true,
      default: () => crypto.randomBytes(4).toString("hex"),
    },
  },
  { timestamps: true },
);

// Indexes for performance optimization
workspaceSchema.index({ "members.userId": 1 });
workspaceSchema.index({ createdById: 1 });

export default mongoose.model("Workspace", workspaceSchema);
