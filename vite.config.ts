import { defineConfig } from 'vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, readdirSync, statSync, renameSync, rmdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

function moveFilesToRoot(dir: string, root: string) {
  const files = readdirSync(dir);
  for (const file of files) {
    const srcPath = join(dir, file);
    const destPath = join(root, file);
    const stat = statSync(srcPath);
    if (stat.isDirectory()) {
      moveFilesToRoot(srcPath, root);
      rmdirSync(srcPath);
    } else {
      renameSync(srcPath, destPath);
    }
  }
}

function fixHtmlPaths(dir: string) {
  const files = readdirSync(dir);
  for (const file of files) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      fixHtmlPaths(filePath);
    } else if (file.endsWith('.html')) {
      let content = readFileSync(filePath, 'utf-8');
      // Fix relative paths from ../../assets/ to ./assets/
      content = content.replace(/\.\.\/\.\.\/assets\//g, './assets/');
      writeFileSync(filePath, content);
    }
  }
}

export default defineConfig({
  root: '.',
  publicDir: 'public',
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        'service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
        'content-script': resolve(__dirname, 'src/content/content-script.ts'),
        'offscreen': resolve(__dirname, 'src/offscreen/offscreen.html'),
        'popup': resolve(__dirname, 'src/popup/popup.html'),
        'sidepanel': resolve(__dirname, 'src/sidepanel/sidepanel.html'),
        'options': resolve(__dirname, 'src/options/options.html'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'service-worker' || chunkInfo.name === 'content-script') {
            return '[name].js';
          }
          return 'assets/[name].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          const info = assetInfo.name || '';
          if (info.endsWith('.css')) {
            return 'assets/[name]-[hash][extname]';
          }
          return '[name][extname]';
        },
        manualChunks: (id) => {
          if (id.includes('node_modules/tesseract.js')) {
            return 'tesseract';
          }
          if (id.includes('node_modules/pdfjs-dist')) {
            return 'pdfjs';
          }
        },
      },
    },
  },
  plugins: [
    {
      name: 'post-build-cleanup',
      writeBundle() {
        try {
          // Copy sql-wasm.wasm
          mkdirSync('dist', { recursive: true });
          copyFileSync(
            resolve(__dirname, 'node_modules/sql.js/dist/sql-wasm.wasm'),
            resolve(__dirname, 'dist/sql-wasm.wasm')
          );

          // Copy pdf.worker.mjs for pdfjs-dist v5 Web Worker
          copyFileSync(
            resolve(__dirname, 'node_modules/pdfjs-dist/build/pdf.worker.mjs'),
            resolve(__dirname, 'dist/pdf.worker.mjs')
          );

          const distDir = resolve(__dirname, 'dist');

          // Move HTML files from dist/src/* to dist/*
          const srcDir = resolve(distDir, 'src');
          try {
            moveFilesToRoot(srcDir, distDir);
            rmdirSync(srcDir);
          } catch {
            // src dir might not exist
          }

          // Fix paths in HTML files
          fixHtmlPaths(distDir);
        } catch (e) {
          console.warn('Post-build cleanup error:', e);
        }
      }
    }
  ]
});
