import { Router } from "express";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { checkProjectRole } from "../../../middleware/project.middleware.js";
import { validate } from "../../../middleware/validate.middleware.js";
import { CreateProjectCollectionDto, ImportLibraryCollectionDto, AddPaperToProjectCollectionDto } from "./project-collection.dto.js";

export const buildProjectCollectionRouter = (controller) => {
  const pcRouter = Router();

  pcRouter.get(
    "/project/:projectId/collections",
    isAuthenticated,
    checkProjectRole("manager", "member", "viewer"),
    controller.getProjectCollections
  );

  pcRouter.post(
    "/project/:projectId/collections",
    isAuthenticated,
    checkProjectRole("manager", "member"),
    validate(CreateProjectCollectionDto),
    controller.createProjectCollection
  );

  pcRouter.post(
    "/project/:projectId/collections/:pcId/import-library",
    isAuthenticated,
    checkProjectRole("manager", "member"),
    validate(ImportLibraryCollectionDto),
    controller.importLibraryCollection
  );

  pcRouter.post(
    "/project/:projectId/collections/:pcId/papers",
    isAuthenticated,
    checkProjectRole("manager", "member"),
    validate(AddPaperToProjectCollectionDto),
    controller.addPaperToProjectCollection
  );

  pcRouter.delete(
    "/project/:projectId/collections/:pcId/papers/:paperId",
    isAuthenticated,
    checkProjectRole("manager", "member"),
    controller.removePaperFromProjectCollection
  );

  pcRouter.delete(
    "/project/:projectId/collections/:pcId",
    isAuthenticated,
    checkProjectRole("manager"),
    controller.deleteProjectCollection
  );

  return pcRouter;
};
