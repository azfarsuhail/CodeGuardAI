import "dotenv/config";
import { defineConfig } from "prisma/config";

// CLI (migrate/db push) uses Supabase's direct connection; the app uses the pooled DATABASE_URL.
// Soft read so `prisma generate` (postinstall) works without a database configured.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DIRECT_URL ?? "" },
});
