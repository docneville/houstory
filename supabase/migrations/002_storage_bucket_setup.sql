-- Storage bucket setup for houstory-media
-- Unlike five-wonders' public place-photos bucket, this bucket is PRIVATE:
-- it holds personal home photos/receipts, gated by property membership.
-- Objects are stored at path {property_id}/{filename}, so the first
-- folder segment doubles as the access-control key.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'houstory-media',
  'houstory-media',
  false,
  26214400, -- 25MB
  ARRAY['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  public = false,
  file_size_limit = 26214400,
  allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/heic', 'image/webp', 'application/pdf'];

CREATE POLICY "Members can read their property's media" ON storage.objects
  FOR SELECT USING (
    bucket_id = 'houstory-media'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT property_id FROM property_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Members can upload media for their properties" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'houstory-media'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT property_id FROM property_members WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Members can delete their property's media" ON storage.objects
  FOR DELETE USING (
    bucket_id = 'houstory-media'
    AND (storage.foldername(name))[1]::uuid IN (
      SELECT property_id FROM property_members WHERE user_id = auth.uid()
    )
  );
