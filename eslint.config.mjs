// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

// `.mjs` so the imports load as ESM: the root package.json has no `"type": "module"`.
// Syntactic rules only; the root tsconfig is a solution file, so type-aware rules would
// error on files that belong to no project.
export default tseslint.config(
  {
    ignores: [".claude/**", "**/node_modules/**", "**/dist/**", "**/coverage/**", "**/*.d.ts"],
  },
  {
    files: ["**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { process: "readonly", console: "readonly", URL: "readonly" },
    },
  },
  {
    // Vendored third-party skills: kept byte-identical to upstream, so not linted.
    ignores: ["apps/build/bridge/skills/**"],
  },
  {
    files: ["apps/build/bridge/**/*.mjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        process: "readonly", console: "readonly", URL: "readonly", Buffer: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly",
        AbortController: "readonly", fetch: "readonly", TextDecoder: "readonly", structuredClone: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["apps/build/ui/**/*.js"],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        window: "readonly", document: "readonly", location: "readonly", localStorage: "readonly",
        console: "readonly", URL: "readonly", WebSocket: "readonly", fetch: "readonly",
        setTimeout: "readonly", clearTimeout: "readonly", setInterval: "readonly", clearInterval: "readonly",
        requestAnimationFrame: "readonly", navigator: "readonly", HTMLElement: "readonly", Event: "readonly",
        addEventListener: "readonly", MutationObserver: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
