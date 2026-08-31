-- =============================================================================
-- Migration: 20260901000001_library_reading_constraints_phase5
-- Purpose: Additive check constraints on UserItemState reading rating (1..5 stars)
-- Mode: Strictly Additive (Zero Drops)
-- =============================================================================

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_item_states_rating_check'
    ) THEN
        ALTER TABLE "user_item_states" 
        ADD CONSTRAINT "user_item_states_rating_check" 
        CHECK ("rating" IS NULL OR ("rating" >= 0 AND "rating" <= 5));
    END IF;
END $$;
