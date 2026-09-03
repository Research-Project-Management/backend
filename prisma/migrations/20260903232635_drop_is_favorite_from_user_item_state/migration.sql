-- Drop isFavorite column from user_item_states
-- Feature removed: library item favorite tracking is no longer supported

-- 1. Drop the index on (user_id, is_favorite) first
DROP INDEX IF EXISTS "user_item_states_user_id_is_favorite_idx";

-- 2. Drop the column
ALTER TABLE "user_item_states" DROP COLUMN IF EXISTS "is_favorite";
