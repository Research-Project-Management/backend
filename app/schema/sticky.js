import mongoose from "mongoose";

// ── Tag Schema ────────────────────────────────────────────────────────────────

const labelSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  color: { type: String, default: "#3b82f6" },
  workspace: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: "Workspace", 
    required: true 
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  type: { type: String, enum: ["sticky", "cycle", "task"], default: "sticky" }
}, { timestamps: true });

labelSchema.index({ workspace: 1, name: 1, type: 1 });

// Cleanup hook: When a tag is deleted, remove its ID from all stickies and cycles
labelSchema.pre('findOneAndDelete', async function(next) {
  const doc = await this.model.findOne(this.getQuery());
  if (doc) {
    await Promise.all([
      mongoose.model("Sticky").updateMany(
        { labels: doc._id },
        { $pull: { labels: doc._id } }
      ),
      mongoose.model("Cycle").updateMany(
        { labels: doc._id },
        { $pull: { labels: doc._id } }
      ),
      mongoose.model("Task").updateMany(
        { labels: doc._id },
        { $pull: { labels: doc._id } }
      )
    ]);
  }
  next();
});

export const LabelModel =
  mongoose.models.Label || mongoose.model("Label", labelSchema, "tags");

export const TagModel = LabelModel;

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
