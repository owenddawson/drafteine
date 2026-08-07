import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "eslint.config.js"] },
  ...tseslint.configs.recommended,
  {
    files: ["packages/*/test/**"],
    rules: {
      // execFileSync error objects are untyped by design in tests
      "@typescript-eslint/no-explicit-any": "off",
    },
  }
);
