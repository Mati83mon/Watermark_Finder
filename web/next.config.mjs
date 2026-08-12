/** @type {import('next').NextConfig} */
const nextConfig = {
  // Cloudflare Pages serves this as a static site. All data comes from the
  // Worker API at runtime, so there is nothing to render on a server and
  // nothing that needs the next-on-pages adapter.
  output: 'export',
  reactStrictMode: true,
  trailingSlash: true,
  images: { unoptimized: true },
  // The shared types package is TypeScript source, not a build artefact.
  transpilePackages: ['@wf/shared'],
};

export default nextConfig;
