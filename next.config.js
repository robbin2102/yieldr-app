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

      // MetaMask SDK tries to import this React Native module - mock it for browser
      config.resolve.alias = {
        ...config.resolve.alias,
        '@react-native-async-storage/async-storage': false,
      };
    }

    // Only externalize idb-related packages on the server
    // On client, they need to be bundled for browser IndexedDB support
    if (isServer) {
      config.externals.push({
        'idb-keyval': 'idb-keyval',
        'idb': 'idb',
      });
    }

    return config;
  },
};

module.exports = nextConfig;
