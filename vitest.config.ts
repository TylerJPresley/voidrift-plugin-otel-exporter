import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    setupFiles: ["./src/test-hermetic.ts"],
    globalSetup: ["./src/test-hermetic.global.ts"],
    include: ["src/**/*.test.ts", "src/**/*.spec.ts"],
  },
});
