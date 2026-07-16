import mongoose from "mongoose";

// ── Sticky Note Link Schema ───────────────────────────────────────────────────

const stickyNoteLinkSchema = new mongoose.Schema(
  {
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    parentSticky: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sticky",
      required: true,
    },
    childSticky: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sticky",
      required: true,
    },
    childNote: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sticky",
      select: false,
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

stickyNoteLinkSchema.index(
  { workspace: 1, parentSticky: 1, project: 1, author: 1 },
);
stickyNoteLinkSchema.pre("validate", function normalizeStickyChildLink(next) {
  if (!this.childSticky && this.childNote) this.childSticky = this.childNote;
  next();
});

stickyNoteLinkSchema.index(
  { childSticky: 1, author: 1 },
  { unique: true },
);

export const StickyChildLinkModel =
  mongoose.models.StickyNoteLink ||
  mongoose.model("StickyNoteLink", stickyNoteLinkSchema);

export const StickyNoteLinkModel = StickyChildLinkModel;

// ── Sticky Schema ─────────────────────────────────────────────────────────────

const stickySchema = new mongoose.Schema({
  title: { type: String, default: "" },
  content: { type: String, required: true },
  color: { 
    type: String, 
    enum: ['cyan-1', 'cyan-2', 'mint-1', 'mint-2', 'yellow-1', 'lavender-1', 'pink-1', 'purple-1'],
    default: 'yellow-1'
  },
  workspace: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Workspace",
    required: true
  },
  labels: [{ type: mongoose.Schema.Types.ObjectId, ref: "Label" }],
  author: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Project"
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

stickySchema.index({ workspace: 1, createdAt: -1 });
stickySchema.index({ workspace: 1, labels: 1 });
stickySchema.index({ projectId: 1, author: 1 });
stickySchema.index({ content: 'text', title: 'text' });

export const StickyModel = mongoose.models.Sticky || mongoose.model("Sticky", stickySchema);

export default StickyModel;
