/**
 * LaserLink web interface.
 * Static export so the receiver page can be hosted on GitHub Pages (HTTPS is
 * required for getUserMedia on a phone) with no server.
 *
 * For a project page at https://<user>.github.io/<repo>/ set:
 *   NEXT_PUBLIC_BASE_PATH=/<repo>
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath,
  assetPrefix: basePath || undefined,
  trailingSlash: true,
  images: { unoptimized: true },
  reactStrictMode: true,
};

export default nextConfig;
