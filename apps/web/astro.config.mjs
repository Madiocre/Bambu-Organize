// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import { cacheCloudflare } from '@astrojs/cloudflare/cache';

// https://astro.build/config
export default defineConfig({
  adapter: cloudflare(),
  cache: {
    provider: cacheCloudflare(),
  },
  vite: {
    ssr: {
      // The workspace packages ship TypeScript source rather than a build
      // step, so Vite has to transform them instead of externalising them.
      noExternal: ['@bambu-organize/db', '@bambu-organize/shared'],
    },
  },
});
