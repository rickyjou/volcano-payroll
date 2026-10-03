import path from 'node:path';
import type { NextConfig } from 'next';

// The app imports shared code from ../src, so the workspace root is the repo root.
const root = path.resolve(__dirname, '..');

const nextConfig: NextConfig = {
  turbopack: { root },
  outputFileTracingRoot: root,
};

export default nextConfig;
