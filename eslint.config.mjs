import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Pastoral note text must never reach logs: no console.log / console.info anywhere.
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  { files: ["scripts/**"], rules: { "no-console": "off" } },
  globalIgnores([".next/**", "node_modules/**", "src/server/db/migrations/**", "next-env.d.ts", ".cache/**"]),
]);
