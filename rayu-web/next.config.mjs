/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produce a self-contained server bundle for the Docker image.
  output: 'standalone',
}

export default nextConfig
