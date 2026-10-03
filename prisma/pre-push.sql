-- Prisma's introspection rejects foreign keys into schemas it doesn't manage (P4002), so the User -> auth.users
-- backstop is dropped for the duration of `prisma db push`; prisma/rls.sql re-adds it immediately after.
ALTER TABLE IF EXISTS "User" DROP CONSTRAINT IF EXISTS "User_id_auth_users_fkey";
