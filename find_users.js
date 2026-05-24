import mongoose from "mongoose";
import UserModel from "./app/schema/user.js";
import dotenv from "dotenv";

dotenv.config();

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB!");
  const users = await UserModel.find({});
  console.log("Users count:", users.length);
  for (const user of users) {
    console.log(`- ID: ${user._id}`);
    console.log(`  Name: ${user.name}`);
    console.log(`  Email: ${user.email}`);
    console.log("-----------------------------------------");
  }
  await mongoose.disconnect();
}

run().catch(console.error);
