/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // mupdf ships a WASM binary that must not be bundled/transformed by the
  // server build — keep it external so it loads from node_modules at runtime.
  serverExternalPackages: ["ioredis", "mupdf"],
};

export default nextConfig;
