-- Lexical search index for the sparse half of retrieval.
--
-- 'simple' rather than 'english': the transcript is code-mixed, English stemming mangles Hindi
-- words, and exact tokens (names, ticket ids, product codes) are what this lane exists to find.
-- The context prefix is indexed with the text because it is also part of what gets embedded.

CREATE INDEX IF NOT EXISTS chunks_text_idx ON chunks
    USING GIN (to_tsvector('simple', context_prefix || ' ' || text));
