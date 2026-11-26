// Generation only (`npm run db:generate`); it never connects to a database.
// Migrations are applied explicitly with `npm run db:migrate`, never by the build.
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: ["./src/server/db/auth-schema.ts", "./src/server/db/schema.ts"],
  out: "./src/server/db/migrations",
  strict: true,
});
