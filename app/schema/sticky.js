import mongoose from "mongoose";

// ── Tag Schema ────────────────────────────────────────────────────────────────

const tagSchema = new mongoose.Schema({
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
  }
}, { timestamps: true });

tagSchema.index({ workspace: 1, name: 1 });

// Cleanup hook: When a tag is deleted, remove its ID from all stickies
tagSchema.pre('findOneAndDelete', async function(next) {
  const doc = await this.model.findOne(this.getQuery());
  if (doc) {
    await mongoose.model("Sticky").updateMany(
      { tags: doc._id },
      { $pull: { tags: doc._id } }
    );
  }
  next();
});

export const TagModel = mongoose.models.Tag || mongoose.model("Tag", tagSchema);

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
    childNote: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Sticky",
      required: true,
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
stickyNoteLinkSchema.index(
  { childNote: 1, author: 1 },
  { unique: true },
);

export const StickyNoteLinkModel =
  mongoose.models.StickyNoteLink ||
  mongoose.model("StickyNoteLink", stickyNoteLinkSchema);

// ── Sticky Schema ─────────────────────────────────────────────────────────────

const stickySchema = new mongoose.Schema({
  title: { type: String, default: "" },
  content: { type: String, required: true },
  color: { 
    type: String, 
    enum: ['cyan-1', 'cyan-2', 'mint-1', 'mint-2', 'yellow-1', 'lavender-1', 'pink-1', 'purple-1', 'cyan-1'], // Added cyan-1 as extra safety
    default: 'yellow-1'
  },
  workspace: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Workspace",
    required: true
  },
  tags: [{ type: mongoose.Schema.Types.ObjectId, ref: "Tag" }],
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
  position: {
    x: { type: Number, default: 0 },
    y: { type: Number, default: 0 }
  },
  order: { type: Number, default: 0 }
}, { timestamps: true });

stickySchema.pre("validate", function normalizeStickyScope(next) {
  if (this.projectId) {
    this.category = "note";
  } else if (this.category === "note") {
    this.category = "sticky";
  }
  next();
});

stickySchema.index({ workspace: 1, createdAt: -1 });
stickySchema.index({ workspace: 1, tags: 1 });
stickySchema.index({ projectId: 1, author: 1 });
stickySchema.index({ content: 'text', title: 'text' });

export const StickyModel = mongoose.models.Sticky || mongoose.model("Sticky", stickySchema);

export default StickyModel;
