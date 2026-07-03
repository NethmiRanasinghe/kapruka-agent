/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.kapruka.com" },
      { protocol: "https", hostname: "kapruka.com" },
    ],
  },
};

module.exports = nextConfig;
