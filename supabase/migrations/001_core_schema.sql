-- Migration: Core schema (properties, property_members, chapters, media)
-- See beads houstory-96t for the design discussion this implements.

-- ============================================
-- properties: one row per residence
-- ============================================
CREATE TABLE properties (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nickname      TEXT,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city          TEXT NOT NULL,
  state         TEXT NOT NULL,
  postal_code   TEXT,
  country       TEXT NOT NULL DEFAULT 'US',
  created_by    UUID NOT NULL REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

-- ============================================
-- property_members: many-to-many users <-> properties
-- ============================================
CREATE TABLE property_members (
  property_id UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'member', 'viewer')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (property_id, user_id)
);

ALTER TABLE property_members ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_property_members_user ON property_members(user_id);

-- property_members policies reference only auth.uid(), never property_members
-- itself, to avoid RLS self-recursion. "Can I see other members of my
-- property" is deliberately deferred to Phase 2 (houstory-96t.10) behind a
-- SECURITY DEFINER helper function.
CREATE POLICY "Users can view their own membership rows" ON property_members
  FOR SELECT USING (user_id = auth.uid());

CREATE POLICY "Users can add themselves as a property member" ON property_members
  FOR INSERT WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update their own membership row" ON property_members
  FOR UPDATE USING (user_id = auth.uid());

CREATE POLICY "Users can remove their own membership row" ON property_members
  FOR DELETE USING (user_id = auth.uid());

-- properties policies (safe to reference property_members - one direction only)
CREATE POLICY "Members can view their properties" ON properties
  FOR SELECT USING (
    id IN (SELECT property_id FROM property_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Authenticated users can create a property" ON properties
  FOR INSERT WITH CHECK (auth.uid() = created_by);

CREATE POLICY "Owners can update their properties" ON properties
  FOR UPDATE USING (
    id IN (SELECT property_id FROM property_members WHERE user_id = auth.uid() AND role = 'owner')
  );

CREATE POLICY "Owners can delete their properties" ON properties
  FOR DELETE USING (
    id IN (SELECT property_id FROM property_members WHERE user_id = auth.uid() AND role = 'owner')
  );

-- ============================================
-- chapters: the flexible core unit (renovation, paint, appliance,
-- landscaping, research, general - chapter_type is free text on purpose,
-- not a hard enum, since the set of categories is expected to evolve)
-- ============================================
CREATE TABLE chapters (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  chapter_type   TEXT NOT NULL DEFAULT 'general',
  title          TEXT NOT NULL,
  description    TEXT,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'archived')),
  started_at     DATE,
  completed_at   DATE,
  estimated_cost NUMERIC(12, 2),
  actual_cost    NUMERIC(12, 2),
  currency       TEXT NOT NULL DEFAULT 'USD',
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by     UUID NOT NULL REFERENCES auth.users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE chapters ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_chapters_property ON chapters(property_id);

CREATE POLICY "Members can view chapters for their properties" ON chapters
  FOR SELECT USING (
    property_id IN (SELECT property_id FROM property_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Members can create chapters for their properties" ON chapters
  FOR INSERT WITH CHECK (
    property_id IN (SELECT property_id FROM property_members WHERE user_id = auth.uid())
    AND created_by = auth.uid()
  );

CREATE POLICY "Members can update chapters for their properties" ON chapters
  FOR UPDATE USING (
    property_id IN (SELECT property_id FROM property_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Members can delete chapters for their properties" ON chapters
  FOR DELETE USING (
    property_id IN (SELECT property_id FROM property_members WHERE user_id = auth.uid())
  );

-- ============================================
-- media: photos and documents. chapter_id is nullable - a photo can be
-- uploaded before Claude/the user has decided which chapter it belongs to.
-- ============================================
CREATE TABLE media (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id    UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  chapter_id     UUID REFERENCES chapters(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL DEFAULT 'photo' CHECK (kind IN ('photo', 'document', 'link')),
  storage_path   TEXT,
  source_url     TEXT,
  caption        TEXT,
  ai_description TEXT,
  ai_extracted   JSONB NOT NULL DEFAULT '{}'::jsonb,
  status         TEXT NOT NULL DEFAULT 'pending_review' CHECK (status IN ('pending_review', 'confirmed')),
  taken_at       TIMESTAMPTZ,
  uploaded_by    UUID NOT NULL REFERENCES auth.users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE media ENABLE ROW LEVEL SECURITY;

CREATE INDEX idx_media_property ON media(property_id);
CREATE INDEX idx_media_chapter ON media(chapter_id);

CREATE POLICY "Members can view media for their properties" ON media
  FOR SELECT USING (
    property_id IN (SELECT property_id FROM property_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Members can upload media for their properties" ON media
  FOR INSERT WITH CHECK (
    property_id IN (SELECT property_id FROM property_members WHERE user_id = auth.uid())
    AND uploaded_by = auth.uid()
  );

CREATE POLICY "Members can update media for their properties" ON media
  FOR UPDATE USING (
    property_id IN (SELECT property_id FROM property_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Members can delete media for their properties" ON media
  FOR DELETE USING (
    property_id IN (SELECT property_id FROM property_members WHERE user_id = auth.uid())
  );

-- ============================================
-- Keep updated_at current
-- ============================================
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER properties_touch_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER chapters_touch_updated_at
  BEFORE UPDATE ON chapters
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER media_touch_updated_at
  BEFORE UPDATE ON media
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
