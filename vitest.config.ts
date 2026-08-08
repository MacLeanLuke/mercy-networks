import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Mirrors the "@/*" path alias in tsconfig.json. Without this, any test
    // touching a module that imports via "@/" fails to resolve.
    alias: { "@": resolve(__dirname, ".") },
  },
  test: {
    // The existing hook test calls describe/it/expect without importing them.
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
  },
});
