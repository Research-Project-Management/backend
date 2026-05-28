import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

const FileSchema = new mongoose.Schema({}, { strict: false });
const FileModel = mongoose.model("File", FileSchema, "files");

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB!");
  
  // Find recent files, especially images
  const files = await FileModel.find({ isFolder: false })
    .sort({ createdAt: -1 })
    .limit(30)
    .lean();
    
  console.log(`Found ${files.length} recent files:`);
  for (const file of files) {
    console.log(`- ID: ${file._id}`);
    console.log(`  Filename: ${file.filename}`);
    console.log(`  MimeType: ${file.mimeType}`);
    console.log(`  URL: ${file.url}`);
    console.log(`  Thumbnail: ${file.thumbnail}`);
    console.log(`  CreatedAt: ${file.createdAt}`);
    console.log("-----------------------------------------");
  }
  
  await mongoose.disconnect();
}

run().catch(console.error);
