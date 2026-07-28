-- Migration: Auto-add creator as owner member when a property is created
--
-- Fixes a chicken-and-egg RLS problem: INSERT ... RETURNING (which
-- supabase-js's .select() after .insert() triggers) re-checks the new row
-- against the table's SELECT policy before returning it. A brand new
-- property has no property_members row yet, so that check failed even
-- though the INSERT policy itself was satisfied. This trigger creates the
-- owner membership row in the same statement, before that visibility
-- check happens, and removes the need for the client to do a separate
-- property_members insert at all.

CREATE OR REPLACE FUNCTION add_property_creator_as_owner()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO property_members (property_id, user_id, role)
  VALUES (NEW.id, NEW.created_by, 'owner')
  ON CONFLICT (property_id, user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER properties_add_creator_as_owner
  AFTER INSERT ON properties
  FOR EACH ROW EXECUTE FUNCTION add_property_creator_as_owner();
