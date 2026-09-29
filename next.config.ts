import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  turbopack: {
    root: process.cwd(),
  },
  async rewrites() {
    return {
      beforeFiles: [],
      afterFiles: [
        {
          // A file uploaded from the Files page is on GitHub before it's in a
          // build. Next.js serves real public/ files before afterFiles rewrites,
          // so only those not-yet-built files reach this route. The extensions
          // must match UPLOAD_EXTENSIONS in lib/files/upload-rules.ts.
          source: "/:name([a-z0-9][a-z0-9_-]*\\.(?:pdf|png|jpg|jpeg|webp|gif))",
          destination: "/api/files/raw/:name",
        },
      ],
      fallback: [],
    };
  },
};

export default nextConfig;
