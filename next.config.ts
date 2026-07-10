import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Use standalone output for Vercel/Netlify deployment compatibility.
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
};

export default nextConfig;
