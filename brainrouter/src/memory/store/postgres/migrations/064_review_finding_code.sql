-- ADR-036 D1/D6 — a review finding carries its own code.
--
-- The finding contract already produces `codeExcerpt` (a few verbatim lines of the
-- reviewed source) and `replacement` (the proposed fix), but the durable finding
-- stored only file_path + line range — so the review console could show file:line
-- and nothing more, forcing a redirect to GitHub. Persist the (already-redacted)
-- excerpt + replacement WITH the finding so the review renders its own code:
-- offline, without forge credentials, and after the branch is gone (D1). Redaction
-- happens on the way IN (D6, redactReviewSourceText), never at display time.
ALTER TABLE review_findings ADD COLUMN IF NOT EXISTS code_excerpt     text;
ALTER TABLE review_findings ADD COLUMN IF NOT EXISTS code_replacement text;
