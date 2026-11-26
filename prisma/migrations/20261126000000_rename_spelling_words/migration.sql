-- Rename custom_dictionary_words -> spelling_words (zero data loss)
ALTER TABLE "public"."custom_dictionary_words" RENAME TO "spelling_words";
ALTER TABLE "public"."spelling_words" RENAME CONSTRAINT "custom_dictionary_words_pkey" TO "spelling_words_pkey";
ALTER TABLE "public"."spelling_words" RENAME CONSTRAINT "fk_custom_dictionary_words_space_id" TO "fk_spelling_words_space_id";
ALTER INDEX "public"."uq_custom_dictionary_words_space_word" RENAME TO "uq_spelling_words_space_word";
