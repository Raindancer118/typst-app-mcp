import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { exclude: ["**/node_modules/**", "dist/**", ...(process.env.TYPST_E2E === "1" ? [] : ["test/e2e/**"])] }
});
