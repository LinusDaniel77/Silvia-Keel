import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "eval-report.md"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/demo/public/**/*.js"],
    languageOptions: { globals: { document: "readonly", fetch: "readonly", window: "readonly" } },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
    },
  },
);
