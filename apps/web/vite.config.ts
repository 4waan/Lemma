import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    sourcemap: false,
    // Every asset is emitted as a file under /assets/: the dashboard's CSP refuses data: URIs.
    assetsInlineLimit: 0,
  },
  server: {
    // `npm run dev` serves the page; API calls go to a running Lemma server.
    proxy: { "/api": process.env["LEMMA_API_URL"] ?? "http://127.0.0.1:3000" },
  },
});
