import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  // Preserve the Vite 6 browser floor, including Safari 14, across upgrades.
  build: { sourcemap: false, target: ["chrome87", "edge88", "firefox78", "safari14"], cssMinify: "lightningcss" },
});
