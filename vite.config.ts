import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/",
  assetsInclude: ["**/*.fbx", "**/*.obj"],
  plugins: [react()],
  server: {
    proxy: {
      "/api/director-agent": "http://127.0.0.1:4319",
    },
    fs: {
      allow: [
        fileURLToPath(new URL(".", import.meta.url)),
        fileURLToPath(new URL("../模型库", import.meta.url)),
      ],
    },
  },
  test: {
    environment: "jsdom",
    exclude: [...configDefaults.exclude, "agent-service/**/*.test.mjs"],
    globals: true,
    pool: "threads",
    maxWorkers: 1,
    setupFiles: "./src/test/setup.ts",
  },
});
