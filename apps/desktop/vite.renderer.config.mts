import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Strict Content Security Policy for the packaged app. Not applied in development, where React's
// hot reload needs an inline script.
const contentSecurityPolicy: Plugin = {
  name: "away-content-security-policy",
  apply: "build",
  transformIndexHtml: () => [
    {
      tag: "meta",
      attrs: {
        "http-equiv": "Content-Security-Policy",
        content: "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'",
      },
      injectTo: "head-prepend",
    },
  ],
};

export default defineConfig({
  plugins: [react(), tailwindcss(), contentSecurityPolicy],
});
