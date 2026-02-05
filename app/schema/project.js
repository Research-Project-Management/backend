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
      default: ["overview", "tasks", "pages", "storage", "stickies"],
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
          isDefault: false,
          accentColor: "#64748b",
        },
        { id: "todo", title: "To Do", isDefault: true, accentColor: "#e2e8f0" },
        {
          id: "doing",
          title: "Doing",
          isDefault: false,
          accentColor: "#3b82f6",
        },
        {
          id: "review",
          title: "Review",
          isDefault: false,
          accentColor: "#eab308",
        },
        { id: "done", title: "Done", isDefault: false, accentColor: "#22c55e" },
      ],
    },
    settings: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
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
