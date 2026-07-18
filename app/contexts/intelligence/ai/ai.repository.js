import AiModel from "./ai.schema.js";

export class AiRepository {
  constructor() {
    this.model = AiModel;
  }

  async findMemories(userId, workspaceId, scopedOrConditions, limit) {
    return this.model.find({
      user: userId,
      workspace: workspaceId,
      $or: scopedOrConditions,
    })
      .sort({ confidence: -1, updatedAt: -1 })
      .limit(limit)
      .lean();
  }

  async upsertMemory(userId, workspaceId, projectId, scope, type, content, confidence, sourceChatId) {
    return this.model.findOneAndUpdate(
      {
        user: userId,
        workspace: workspaceId,
        projectId,
        scope,
        type,
        content,
      },
      {
        $set: {
          confidence,
          sourceChatId,
        },
      },
      { upsert: true, new: true }
    );
  }

  async deleteMemoriesByWorkspace(workspaceId, userId) {
    return this.model.deleteMany({
      user: userId,
      workspace: workspaceId,
    });
  }
}
