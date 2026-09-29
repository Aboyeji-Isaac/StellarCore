import "dotenv/config";
import { defineConfig } from "prisma/config";

// Only the Prisma CLI reads the migration owner credential. The deployed
// runtime uses DATABASE_READ_URL / DATABASE_WRITE_URL (lib/db/connection.ts)
// and must never be configured with MIGRATION_DATABASE_URL. The URL is
// optional here so `prisma generate` (npm postinstall) runs without any
// database credential; migrate commands fail when it is absent.
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.MIGRATION_DATABASE_URL,
  },
});
