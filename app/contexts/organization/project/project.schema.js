import mongoose from "mongoose";

const projectMemberSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  role: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Role",
    required: true,
  },
  joinedAt: { type: Date, default: Date.now },
});

const projectSchema = new mongoose.Schema(
  {
    isActive: {
      type: Boolean,
      default: true,
    },
    name: {
      type: String,
      required: true,
    },
    avatar: {
      type: String,
      default: "",
    },
    description: {
      type: String,
      default: "",
    },
    modules: {
      type: [String],
      default: ["overview", "tasks", "cycles", "pages", "storage", "stickies", "collection"],
    },
    members: [projectMemberSchema],
    workspace: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    taskColumns: {
      type: [
        {
          id: String,
          title: String,
          isDefault: Boolean,
          accentColor: String,
        },
      ],
      default: [
        {
          id: "backlog",
          title: "Backlog",
          isDefault: true,
          accentColor: "#6366F1",
        },
        { id: "todo", title: "To Do", isDefault: true, accentColor: "#0EA5E9" },
        {
          id: "doing",
          title: "Doing",
          isDefault: true,
          accentColor: "#F59E0B",
        },
        {
          id: "review",
          title: "Review",
          isDefault: true,
          accentColor: "#eab308",
        },
        { id: "done", title: "Done", isDefault: true, accentColor: "#22c55e" },
      ],
    },
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    taskSequence: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  },
);

// Indexes for performance optimization
projectSchema.index({ workspace: 1 });
projectSchema.index({ "members.user": 1 });
projectSchema.index({ createdBy: 1 });
projectSchema.index({ isActive: 1 });

const ProjectModel =
  mongoose.models.Project || mongoose.model("Project", projectSchema);

export default ProjectModel;
