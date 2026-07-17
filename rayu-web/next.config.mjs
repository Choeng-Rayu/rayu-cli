/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produce a self-contained server bundle for the Docker image.
  output: 'standalone',

  // Suppress warnings about Node.js APIs in Edge Runtime during build
  // The jose library (used by next-auth) uses CompressionStream which
  // is not supported in Edge Runtime, but works fine in Node.js runtime
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
      }
    }
    return config
  },

  // Experimental: Reduce strict checks during build
  experimental: {
    serverComponentsExternalPackages: ['jose'],
  },
}

export default nextConfig
