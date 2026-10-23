import 'dotenv/config';
import { Client } from 'pg';

const sql = `
-- 1. Create Enums if not exist
DO $$ BEGIN
    CREATE TYPE "ConversationType" AS ENUM ('direct', 'group', 'project_channel');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "ConversationMemberRole" AS ENUM ('owner', 'admin', 'member');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "FriendshipStatus" AS ENUM ('pending', 'accepted', 'declined', 'blocked');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE "MessageType" AS ENUM ('text', 'image', 'file', 'system');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- 2. Create Friendships table
CREATE TABLE IF NOT EXISTS "friendships" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "requester_id" UUID NOT NULL,
    "addressee_id" UUID NOT NULL,
    "status" "FriendshipStatus" NOT NULL DEFAULT 'pending',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pk_friendships" PRIMARY KEY ("id"),
    CONSTRAINT "uq_friendship_pair" UNIQUE ("requester_id", "addressee_id"),
    CONSTRAINT "fk_friendships_requester" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE,
    CONSTRAINT "fk_friendships_addressee" FOREIGN KEY ("addressee_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_friendships_requester_status" ON "friendships"("requester_id", "status");
CREATE INDEX IF NOT EXISTS "idx_friendships_addressee_status" ON "friendships"("addressee_id", "status");

-- 3. Create Conversations table
CREATE TABLE IF NOT EXISTS "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "type" "ConversationType" NOT NULL,
    "name" VARCHAR(100),
    "topic" VARCHAR(255),
    "avatar" TEXT,
    "project_id" UUID,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_by_id" UUID NOT NULL,
    "last_message_at" TIMESTAMPTZ(6),
    "last_message_snippet" VARCHAR(255),
    "last_sender_name" VARCHAR(100),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pk_conversations" PRIMARY KEY ("id"),
    CONSTRAINT "fk_conversations_project" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE,
    CONSTRAINT "fk_conversations_creator" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS "idx_conversations_type" ON "conversations"("type");
CREATE INDEX IF NOT EXISTS "idx_conversations_project_id" ON "conversations"("project_id");
CREATE INDEX IF NOT EXISTS "idx_conversations_last_message_at" ON "conversations"("last_message_at" DESC);

-- 4. Create Conversation Members table
CREATE TABLE IF NOT EXISTS "conversation_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "ConversationMemberRole" NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_read_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "is_muted" BOOLEAN NOT NULL DEFAULT false,
    "is_pinned" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "pk_conversation_members" PRIMARY KEY ("id"),
    CONSTRAINT "uq_conversation_member" UNIQUE ("conversation_id", "user_id"),
    CONSTRAINT "fk_conversation_members_conv" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE,
    CONSTRAINT "fk_conversation_members_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "idx_conversation_members_user_read" ON "conversation_members"("user_id", "last_read_at");

-- 5. Create Messages table
CREATE TABLE IF NOT EXISTS "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "sender_id" UUID NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'text',
    "content" TEXT NOT NULL,
    "attachments" JSONB DEFAULT '[]'::jsonb,
    "reply_to_id" UUID,
    "is_edited" BOOLEAN NOT NULL DEFAULT false,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pk_messages" PRIMARY KEY ("id"),
    CONSTRAINT "fk_messages_conversation" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE,
    CONSTRAINT "fk_messages_sender" FOREIGN KEY ("sender_id") REFERENCES "users"("id") ON DELETE RESTRICT,
    CONSTRAINT "fk_messages_reply_to" FOREIGN KEY ("reply_to_id") REFERENCES "messages"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "idx_messages_conv_created" ON "messages"("conversation_id", "created_at" DESC);

-- 6. Create Message Reactions table
CREATE TABLE IF NOT EXISTS "message_reactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "emoji" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "pk_message_reactions" PRIMARY KEY ("id"),
    CONSTRAINT "uq_message_user_reaction" UNIQUE ("message_id", "user_id", "emoji"),
    CONSTRAINT "fk_message_reactions_message" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE,
    CONSTRAINT "fk_message_reactions_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
`;

async function main() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  console.log('Connecting to PostgreSQL...');
  await client.connect();
  console.log('Connected! Executing chat migration SQL...');
  await client.query(sql);
  console.log('Chat tables created successfully in PostgreSQL!');
  await client.end();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
