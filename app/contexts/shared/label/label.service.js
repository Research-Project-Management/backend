import { AppError } from "../../../lib/AppError.js";

export class LabelService {
  constructor({ labelRepository }) {
    this.labelRepository = labelRepository;
  }

  async getLabels(workspaceId, type) {
    const filter = { workspace: workspaceId };
    if (type && ["sticky", "cycle", "task"].includes(type)) filter.type = type;
    else if (type) return [];
    return this.labelRepository.find(filter);
  }

  async createLabel(workspaceId, { name, color, type }, userId) {
    const label = await this.labelRepository.create({ name, color: color || "#3b82f6", type: type || "sticky", workspace: workspaceId, createdBy: userId });
    await label.populate("createdBy", "name avatar");
    return label;
  }

  async updateLabel(labelId, { name, color }, userId) {
    const label = await this.labelRepository.findByIdPopulated(labelId);
    if (!label) throw new AppError("Label not found", 404);
    const isCreator = label.createdBy?.toString?.() === userId.toString();
    const workspace = label.workspace;
    const userInWs = workspace?.members?.find((m) => m.user.toString() === userId.toString());
    const isAdmin = userInWs && ["owner", "admin"].includes(userInWs.role?.name?.toLowerCase() || "");
    if (!isCreator && !isAdmin) throw new AppError("Access denied", 403);
    if (name !== undefined) label.name = name;
    if (color !== undefined) label.color = color;
    await label.save();
    return label;
  }

  async deleteLabel(labelId, userId) {
    const label = await this.labelRepository.findByIdPopulated(labelId);
    if (!label) throw new AppError("Label not found", 404);
    const isCreator = label.createdBy?.toString?.() === userId.toString();
    const workspace = label.workspace;
    const userInWs = workspace?.members?.find((m) => m.user.toString() === userId.toString());
    const isAdmin = userInWs && ["owner", "admin"].includes(userInWs.role?.name?.toLowerCase() || "");
    if (!isCreator && !isAdmin) throw new AppError("Access denied", 403);
    await this.labelRepository.deleteById(labelId);
  }
}




