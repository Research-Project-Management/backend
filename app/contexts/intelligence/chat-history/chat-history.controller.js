import { asyncHandler } from "../../../lib/asyncHandler.js";

export class ChatHistoryController {
  constructor({ chatHistoryService }) {
    this.chatHistoryService = chatHistoryService;
    
    this.getChats = asyncHandler(async (req, res) => {
      res.json({ chats: await this.chatHistoryService.getChats(req.query.workspaceId, req.user._id.toString()) });
    });
    
    this.createChat = asyncHandler(async (req, res) => {
      res.status(201).json({ chat: await this.chatHistoryService.createChat(req.user._id.toString(), req.body) });
    });
    
    this.getPageChat = asyncHandler(async (req, res) => {
      res.json({ chat: await this.chatHistoryService.getPageChat(req.params.pageId, req.query.workspaceId, req.user._id.toString()) });
    });
    
    this.clearPageChat = asyncHandler(async (req, res) => {
      res.json(await this.chatHistoryService.clearPageChat(req.params.pageId, req.user._id.toString()));
    });
    
    this.getChat = asyncHandler(async (req, res) => {
      res.json({ chat: await this.chatHistoryService.getChat(req.params.chatId, req.user._id.toString()) });
    });
    
    this.appendMessages = asyncHandler(async (req, res) => {
      res.json({ chat: await this.chatHistoryService.appendMessages(req.params.chatId, req.user._id.toString(), req.body) });
    });
    
    this.renameChat = asyncHandler(async (req, res) => {
      res.json({ chat: await this.chatHistoryService.renameChat(req.params.chatId, req.user._id.toString(), req.body) });
    });
    
    this.deleteChat = asyncHandler(async (req, res) => {
      res.json(await this.chatHistoryService.deleteChat(req.params.chatId, req.user._id.toString()));
    });
    
    this.clearMemory = asyncHandler(async (req, res) => {
      res.json(await this.chatHistoryService.clearMemory(req.body.workspaceId, req.user._id.toString()));
    });
  }
}
