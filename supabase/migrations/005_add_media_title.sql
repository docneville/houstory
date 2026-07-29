-- Migration: Add a per-photo title, distinct from a chapter's title
-- (broader bucket name) and a photo's ai_description (longer text).
-- Useful for scanning a chapter's photo grid, and for distinguishing
-- photos once grouped for a single item (houstory-96t.15) - e.g. "Front
-- of unit" vs "Model/serial sticker" for two photos of one appliance.

ALTER TABLE media ADD COLUMN title TEXT;
