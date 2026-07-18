import { Router } from "express";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { aiController } from "../../../container.js";

const aiRouter = Router();

aiRouter.post("/chat", isAuthenticated, aiController.chatStream);
aiRouter.post("/chat/sync", isAuthenticated, aiController.chatSync);
aiRouter.post("/documents/upload", isAuthenticated, aiController.uploadDocument);
aiRouter.get("/documents/bulk", isAuthenticated, aiController.getDocumentBulk);
aiRouter.get("/documents/:docId", isAuthenticated, aiController.getDocument);
aiRouter.get("/documents", isAuthenticated, aiController.getDocuments);
aiRouter.get("/health", aiController.health);

export const buildAiRouter = () => {
  return aiRouter;
};
