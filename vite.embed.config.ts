import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import dts from 'vite-plugin-dts';
import prefixSelector from 'postcss-prefix-selector';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('frontend/src/embed/index.ts', import.meta.url));

export default defineConfig({
  root: 'frontend',
  plugins: [
    react(),
    dts({ tsconfigPath: '../tsconfig.embed.json', include: ['src/embed'], entryRoot: 'src/embed' }),
  ],
  css: {
    postcss: {
      plugins: [
        prefixSelector({
          prefix: '.prdash-root',
          transform(prefix: string, selector: string, prefixedSelector: string) {
            // :root / html / body carry tokens + resets — remap onto the wrapper.
            if (selector === ':root' || selector === 'html' || selector === 'body') return prefix;
            return prefixedSelector;
          },
        }),
      ],
    },
  },
  build: {
    outDir: '../dist/embed',
    emptyOutDir: true,
    sourcemap: true,
    lib: { entry, formats: ['es'], fileName: () => 'index.js', cssFileName: 'style' },
    rollupOptions: {
      external: ['react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    },
  },
});
