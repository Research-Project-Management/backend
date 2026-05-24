import mongoose from "mongoose";
import ChatHistoryModel from "./app/schema/chatHistory.js";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB!");
  const chats = await ChatHistoryModel.find({}).limit(50).lean();
  console.log("Chats count:", chats.length);
  for (const chat of chats) {
    console.log(`- ID: ${chat._id}`);
    console.log(`  Title: ${chat.title}`);
    console.log(`  Workspace: ${chat.workspace} (type: ${typeof chat.workspace})`);
    console.log(`  User: ${chat.user}`);
    console.log(`  DocumentIds: ${JSON.stringify(chat.documentIds || [])}`);
    console.log(`  Messages: ${chat.messages?.length || 0}`);
    console.log("-----------------------------------------");
  }
  await mongoose.disconnect();
}

run().catch(console.error);
