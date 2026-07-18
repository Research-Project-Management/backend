import { Router } from "express";
import { chatHistoryController } from "../../../container.js";
import { isAuthenticated } from "../../../middleware/auth.middleware.js";

const chatHistoryRouter = Router();

chatHistoryRouter.get("/chats", isAuthenticated, chatHistoryController.getChats);
chatHistoryRouter.post("/chats", isAuthenticated, chatHistoryController.createChat);

// IMPORTANT: This route must be declared BEFORE /chats/:chatId so that
// Express does not match "page" as a chatId parameter.
chatHistoryRouter.get("/chats/page/:pageId", isAuthenticated, chatHistoryController.getPageChat);
chatHistoryRouter.delete("/chats/page/:pageId", isAuthenticated, chatHistoryController.clearPageChat);

chatHistoryRouter.get("/chats/:chatId", isAuthenticated, chatHistoryController.getChat);
chatHistoryRouter.patch("/chats/:chatId/messages", isAuthenticated, chatHistoryController.appendMessages);
chatHistoryRouter.patch("/chats/:chatId/title", isAuthenticated, chatHistoryController.renameChat);
chatHistoryRouter.delete("/chats/:chatId", isAuthenticated, chatHistoryController.deleteChat);

chatHistoryRouter.delete("/memory/clear", isAuthenticated, chatHistoryController.clearMemory);

export const buildChatHistoryRouter = () => {
  return chatHistoryRouter;
};
