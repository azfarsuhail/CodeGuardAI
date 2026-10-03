import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Load analyzers from node_modules at runtime instead of bundling them (CommonJS internals, .wasm assets).
  serverExternalPackages: ["eslint", "@typescript-eslint/parser", "@astral-sh/ruff-wasm-nodejs", "java-parser"],
};

export default nextConfig;
