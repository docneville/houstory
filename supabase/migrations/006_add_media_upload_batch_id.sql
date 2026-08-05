-- Migration: Track which photos were submitted together in one batch.
-- Set once client-side per upload submission (whether 1 or many files),
-- so the "Unfiled" gallery can group photos that share one Claude
-- response instead of showing the same description repeated per photo.

ALTER TABLE media ADD COLUMN upload_batch_id UUID;

CREATE INDEX idx_media_upload_batch_id ON media(upload_batch_id);
