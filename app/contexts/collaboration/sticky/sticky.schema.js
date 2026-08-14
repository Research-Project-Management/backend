import mongoose from "mongoose";

const stickySchema = new mongoose.Schema({
  title: { type: String, default: "" },
  content: { type: String, required: true },
  color: { 
    type: String, 
    enum: ['cyan-1', 'cyan-2', 'mint-1', 'mint-2', 'yellow-1', 'lavender-1', 'pink-1', 'purple-1'],
    default: 'yellow-1'
  },
  workspaceId: {
    type: mongoose.Schema.Types.ObjectId, ref: 'Workspace',
    required: true
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId, ref: 'User',
    required: true
  },
  projectId: {
    type: mongoose.Schema.Types.ObjectId, ref: 'Project'
  },
  scope: {
    type: String,
    enum: ['workspace', 'project'],
    default: 'workspace'
  },
  position: {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 }
  },
  order: { type: Number, default: 0 }
}, { timestamps: true });

stickySchema.pre("validate", function normalizeStickyScope(next) {
  if (this.projectId) {
    this.scope = "project";
  } else {
    this.scope = "workspace";
  }
  next();
});

stickySchema.index({ workspaceId: 1, createdAt: -1 });
stickySchema.index({ projectId: 1, userId: 1 });
stickySchema.index({ content: 'text', title: 'text' });

export const StickyModel = mongoose.models.Sticky || mongoose.model("Sticky", stickySchema);

export default StickyModel;
