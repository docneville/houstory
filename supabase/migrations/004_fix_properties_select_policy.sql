-- Migration: Let a creator see a property they just created
--
-- The 003 trigger creates the owner's property_members row, but AFTER
-- ROW triggers in Postgres fire only after the whole statement (including
-- the RLS visibility check backing RETURNING / supabase-js's .select())
-- has already been evaluated - so a fresh INSERT...RETURNING still failed
-- visibility at the moment it mattered. Fix at the policy level instead:
-- a user can always see a property they created, regardless of whether
-- their membership row has landed yet.

DROP POLICY "Members can view their properties" ON properties;

CREATE POLICY "Members can view their properties" ON properties
  FOR SELECT USING (
    id IN (SELECT property_id FROM property_members WHERE user_id = auth.uid())
    OR created_by = auth.uid()
  );
