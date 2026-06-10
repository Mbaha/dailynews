import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  serverExternalPackages: ['pg'],
  allowedDevOrigins: ['192.168.34.232'],
};

export default nextConfig;
