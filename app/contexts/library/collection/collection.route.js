import { Router } from "express";
import { checkWorkspaceRole } from "../../../middleware/workspace.middleware.js";
import { checkProjectRole } from "../../../middleware/project.middleware.js";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { 
  CreateCollectionDto, UpdateCollectionDto,
  CreateProjectCollectionDto, ImportLibraryCollectionDto, AddPaperToProjectCollectionDto
} from "./collection.dto.js";

export const buildCollectionRouter = (controller) => {
  const collectionRouter = Router();

  collectionRouter.get(
    "/:workspaceId/collections",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member", "viewer"),
    controller.getCollections
  );

  collectionRouter.post(
    "/:workspaceId/collections",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(CreateCollectionDto),
    controller.createCollection
  );

  collectionRouter.put(
    "/:workspaceId/collections/:collectionId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    validate(UpdateCollectionDto),
    controller.updateCollection
  );

  collectionRouter.delete(
    "/:workspaceId/collections/:collectionId",
    isAuthenticated,
    checkWorkspaceRole("owner", "admin", "member"),
    controller.deleteCollection
  );

  return collectionRouter;
};

export const buildProjectCollectionRouter = (controller) => {
  const pcRouter = Router();

  pcRouter.get(
    "/project/:projectId/collections",
    isAuthenticated,
    checkProjectRole("owner", "admin", "member", "viewer"),
    controller.getCollections
  );

  pcRouter.post(
    "/project/:projectId/collections",
    isAuthenticated,
    checkProjectRole("owner", "admin", "member"),
    validate(CreateProjectCollectionDto),
    controller.createCollection
  );

  pcRouter.post(
    "/project/:projectId/collections/:pcId/import-library",
    isAuthenticated,
    checkProjectRole("owner", "admin", "member"),
    validate(ImportLibraryCollectionDto),
    controller.importLibraryCollection
  );

  pcRouter.post(
    "/project/:projectId/collections/:pcId/papers",
    isAuthenticated,
    checkProjectRole("owner", "admin", "member"),
    validate(AddPaperToProjectCollectionDto),
    controller.addPaperToProjectCollection
  );

  pcRouter.delete(
    "/project/:projectId/collections/:pcId/papers/:paperId",
    isAuthenticated,
    checkProjectRole("owner", "admin", "member"),
    controller.removePaperFromProjectCollection
  );

  pcRouter.delete(
    "/project/:projectId/collections/:pcId",
    isAuthenticated,
    checkProjectRole("owner", "admin"),
    controller.deleteCollection
  );

  return pcRouter;
};
