-- Migration: profiles table for houstory-96t.11 (Google sign-in)
-- Simpler than Five Wonders' profiles table - no approval-gate workflow
-- (is_admin/approval_status), since Houstory is single-user/family, not
-- invite-gated. Just enough to say who's signed in.

CREATE TABLE profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  first_name TEXT,
  last_name  TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own profile" ON profiles
  FOR SELECT USING (id = auth.uid());

CREATE POLICY "Users can insert their own profile" ON profiles
  FOR INSERT WITH CHECK (id = auth.uid());

CREATE POLICY "Users can update their own profile" ON profiles
  FOR UPDATE USING (id = auth.uid());

-- touch_updated_at() already exists (migration 001)
CREATE TRIGGER profiles_touch_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
