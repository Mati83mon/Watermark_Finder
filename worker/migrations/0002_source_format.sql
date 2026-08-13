-- Record the container the analysed text was extracted from.
--
-- The engine cannot infer this: by the time it sees a string, a PDF and a
-- pasted paragraph are indistinguishable. But it matters for what the result
-- means - PDF cannot carry zero-width characters through extraction, so a
-- clean covert-channel verdict on a PDF says nothing about the original file.
-- Storing it lets the retry sweep pass the same context on a re-run as the
-- first attempt did, so a retried analysis carries the same caveats.
--
-- Nullable and additive: rows written before this migration keep NULL, which
-- the engine treats as "unknown" and does not caveat.

ALTER TABLE analyses ADD COLUMN source_format TEXT;
