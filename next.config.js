/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/',
        destination: '/index.html',
      },
    ];
  },
  
  reactStrictMode: true,
  
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
      };
    }

    // Suppress SSR warnings for browser-only packages
    config.externals.push({
      'idb-keyval': 'idb-keyval',
    });

    return config;
  },
};

module.exports = nextConfig;
