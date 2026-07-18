import mongoose from "mongoose";

// ── Sticky Note Link Schema ───────────────────────────────────────────────────

const stickyNoteLinkSchema = new mongoose.Schema(
  {
    workspaceId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Workspace',
      required: true,
    },
    parentStickyId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Sticky',
      ref: "Sticky",
      required: true,
    },
    childStickyId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Sticky',
      ref: "Sticky",
      required: true,
    },
    childNoteId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Sticky',
      ref: "Sticky",
      select: false,
    },
    projectId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'Project',
      required: true,
    },
    authorId: {
      type: mongoose.Schema.Types.ObjectId, ref: 'User',
      required: true,
    },
  },
  { timestamps: true },
);

stickyNoteLinkSchema.index(
  { workspaceId: 1, parentStickyId: 1, projectId: 1, authorId: 1 },
);
stickyNoteLinkSchema.pre("validate", function normalizeStickyChildLink(next) {
  if (!this.childStickyId && this.childNoteId) this.childStickyId = this.childNoteId;
  next();
});

stickyNoteLinkSchema.index(
  { childStickyId: 1, authorId: 1 },
  { unique: true },
);

export const StickyChildLinkModel =
  mongoose.models.StickyNoteLink ||
  mongoose.model("StickyNoteLink", stickyNoteLinkSchema);

// ── Sticky Schema ─────────────────────────────────────────────────────────────

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
  labels: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Label' }],
  authorId: {
    type: mongoose.Schema.Types.ObjectId, ref: 'User',
    required: true
  },
  projectId: {
    type: mongoose.Schema.Types.ObjectId, ref: 'Project'
  },
  category: {
    type: String,
    enum: ['sticky', 'note'],
    default: 'sticky'
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
  this.category = "sticky";
  next();
});

stickySchema.index({ workspaceId: 1, createdAt: -1 });
stickySchema.index({ workspaceId: 1, labels: 1 });
stickySchema.index({ projectId: 1, authorId: 1 });
stickySchema.index({ content: 'text', title: 'text' });

export const StickyModel = mongoose.models.Sticky || mongoose.model("Sticky", stickySchema);

export default StickyModel;
