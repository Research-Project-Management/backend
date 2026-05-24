import mongoose from "mongoose";
import PaperModel from "./app/schema/paper.js";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB!");
  const papers = await PaperModel.find({ deletedAt: null }).select("title filename fileUrl ragStatus ragDocId ragError");
  console.log("Papers count:", papers.length);
  for (const paper of papers) {
    console.log(`- Title: ${paper.title}`);
    console.log(`  File: ${paper.filename}`);
    console.log(`  RAG Status: ${paper.ragStatus}`);
    console.log(`  RAG Doc ID: ${paper.ragDocId}`);
    console.log(`  RAG Error: ${paper.ragError ? paper.ragError.substring(0, 150) + "..." : "None"}`);
    console.log("-----------------------------------------");
  }
  await mongoose.disconnect();
}

run().catch(console.error);
