/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
      };

      // MetaMask SDK tries to import this React Native module - provide stub for browser
      config.resolve.alias = {
        ...config.resolve.alias,
        '@react-native-async-storage/async-storage': require.resolve('./lib/empty-async-storage.js'),
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

    // Suppress MetaMask SDK async-storage warning
    config.ignoreWarnings = [
      ...(config.ignoreWarnings || []),
      { module: /@metamask\/sdk/ },
    ];

    return config;
  },
};

module.exports = nextConfig;
