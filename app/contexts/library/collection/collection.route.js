import { Router } from "express";
import { checkWorkspaceRole } from "../../../middleware/workspace.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreateCollectionDto, UpdateCollectionDto } from "./collection.dto.js";

export const buildCollectionRouter = (container) => {
  const collectionRouter = Router();
  const controller = container.resolve("collectionController");

  collectionRouter.get(
    "/:workspaceId/collections",
    checkWorkspaceRole("owner", "admin", "member", "viewer"),
    controller.getCollections
  );

  collectionRouter.post(
    "/:workspaceId/collections",
    checkWorkspaceRole("owner", "admin", "member"),
    validate(CreateCollectionDto),
    controller.createCollection
  );

  collectionRouter.put(
    "/:workspaceId/collections/:collectionId",
    checkWorkspaceRole("owner", "admin", "member"),
    validate(UpdateCollectionDto),
    controller.updateCollection
  );

  collectionRouter.delete(
    "/:workspaceId/collections/:collectionId",
    checkWorkspaceRole("owner", "admin", "member"),
    controller.deleteCollection
  );

  return collectionRouter;
};

