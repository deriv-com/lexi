import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import swc from "unplugin-swc";

export default defineConfig({
  // SWC, not esbuild: NestJS services rely on emitDecoratorMetadata, which esbuild does not emit.
  plugins: [swc.vite()],
  test: {
    globals: true,
    environment: "node",
    include: ["packages/*/src/**/*.spec.ts", "apps/*/src/**/*.spec.ts", "scripts/**/*.spec.mjs", "agent-fix/**/*.spec.mjs", "apps/build/**/*.spec.mjs"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    passWithNoTests: true,
    testTimeout: 20000,
    hookTimeout: 20000,
    // Policy loaders read GOVERNANCE_CONFIG_DIR; tests run against the fictional example org.
    env: { GOVERNANCE_CONFIG_DIR: fileURLToPath(new URL("./examples/config", import.meta.url)) },
  },
});
