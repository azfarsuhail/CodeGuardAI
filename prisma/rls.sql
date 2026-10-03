-- Supabase exposes the public schema through its auto-generated REST API (anon/authenticated roles).
-- Enabling RLS with no policies denies those roles everything; the app connects through Prisma as the
-- table owner, which bypasses RLS. Re-run after adding tables: npm run db:rls
ALTER TABLE "User" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Review" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Finding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "FixVersion" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Metrics" ENABLE ROW LEVEL SECURITY;
