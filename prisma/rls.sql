-- Row-level security for Supabase's auto-generated REST API (roles anon / authenticated).
-- The app's server code connects through Prisma as the table owner, which bypasses RLS; these policies govern
-- every request made with a user's own Supabase session, such as the History page.
-- Idempotent: re-run after schema changes with `npm run db:rls` (db:push runs it too).

ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Review" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Finding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FixVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Metrics" ENABLE ROW LEVEL SECURITY;

-- Read-only API surface: signed-in users may SELECT (filtered by the policies below); nobody may write via the API.
REVOKE ALL ON "User", "Review", "Finding", "FixVersion", "Metrics" FROM anon, authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT ON "User", "Review", "Finding", "FixVersion", "Metrics" TO authenticated;

DROP POLICY IF EXISTS "Users read their own profile" ON "User";
CREATE POLICY "Users read their own profile" ON "User"
  FOR SELECT TO authenticated USING (id = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users read their own reviews" ON "Review";
CREATE POLICY "Users read their own reviews" ON "Review"
  FOR SELECT TO authenticated USING ("userId" = (SELECT auth.uid()));

DROP POLICY IF EXISTS "Users read findings of their own reviews" ON "Finding";
CREATE POLICY "Users read findings of their own reviews" ON "Finding"
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM "Review" r WHERE r.id = "Finding"."reviewId" AND r."userId" = (SELECT auth.uid())));

DROP POLICY IF EXISTS "Users read fix versions of their own reviews" ON "FixVersion";
CREATE POLICY "Users read fix versions of their own reviews" ON "FixVersion"
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM "Review" r WHERE r.id = "FixVersion"."reviewId" AND r."userId" = (SELECT auth.uid())));

DROP POLICY IF EXISTS "Users read metrics of their own reviews" ON "Metrics";
CREATE POLICY "Users read metrics of their own reviews" ON "Metrics"
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM "Review" r WHERE r.id = "Metrics"."reviewId" AND r."userId" = (SELECT auth.uid())));

-- FR-004 backstop: tie app profiles to Supabase auth users, so deleting an auth user anywhere (including the
-- Supabase dashboard) also deletes the profile, which cascades to Review -> Finding / FixVersion / Metrics.
-- Not in schema.prisma (Prisma can't reference the auth schema), so db push drops it and this re-adds it.
-- NOT VALID: enforce for new rows without failing on any pre-existing orphaned profile.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'User_id_auth_users_fkey') THEN
    ALTER TABLE "User" ADD CONSTRAINT "User_id_auth_users_fkey"
      FOREIGN KEY (id) REFERENCES auth.users (id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

-- Make PostgREST pick up schema changes immediately.
NOTIFY pgrst, 'reload schema';
