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

/**
 * Parse an `export { a as b, c }` statement and return a map of
 * exported name -> original variable name.
 */
function parseExportBindings(exportStatement: string): Map<string, string> {
  const map = new Map<string, string>();
  // Match the content inside the braces
  const braceMatch = exportStatement.match(/export\s*\{([^}]*)\}/);
  if (!braceMatch) return map;

  const items = braceMatch[1].split(',').map(s => s.trim()).filter(Boolean);
  for (const item of items) {
    const parts = item.split(/\s+as\s+/);
    const original = parts[0].trim();
    const exported = parts[1]?.trim() || original;
    map.set(exported, original);
  }
  return map;
}

/**
 * Inline Rollup chunks imported by entry files back into themselves.
 * Manifest V3 service workers and content scripts must be self-contained;
 * dynamic chunk loading can fail during registration (SW) or on pages
 * with strict CSP (content scripts, e.g. WeChat articles).
 *
 * Each inlined chunk is wrapped in an IIFE to avoid mangled-name collisions
 * between the entry and the chunk (e.g. both declaring `const o = ...`).
 */
function inlineEntryChunks() {
  return {
    name: 'inline-entry-chunks',
    generateBundle(options, bundle) {
      const entryNames = ['content-script.js', 'service-worker.js'];

      for (const entryName of entryNames) {
        const entryChunk = bundle[entryName];
        if (!entryChunk || entryChunk.type !== 'chunk') continue;

        // Match static imports like: import{t as f,i as $}from"./assets/xxx.js";
        const importRegex = /import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["'];?/g;
        let match;
        const imports: { statement: string; bindings: string; path: string }[] = [];
        while ((match = importRegex.exec(entryChunk.code)) !== null) {
          imports.push({ statement: match[0], bindings: match[1], path: match[2] });
        }

        for (const imp of imports) {
          // Import paths are relative from dist root, e.g. "./assets/html-to-markdown-xxx.js"
          const chunkFileName = imp.path.replace(/^\.\//, '');
          const depChunk = bundle[chunkFileName];
          if (!depChunk || depChunk.type !== 'chunk') continue;

          // Parse the chunk's export statement to map exported names -> original variable names
          const exportMatch = depChunk.code.match(/export\s*\{[^}]*\};?/);
          const exportMap = exportMatch ? parseExportBindings(exportMatch[0]) : new Map<string, string>();

          // Parse import bindings: "t as f,i as $" or "h"
          const bindingList = imp.bindings.split(',').map(b => b.trim()).filter(Boolean);
          const returnPairs: string[] = [];
          const destructPairs: string[] = [];

          for (const binding of bindingList) {
            const parts = binding.split(/\s+as\s+/);
            const exportedName = parts[0].trim();
            const localName = parts[1]?.trim() || exportedName;
            const originalName = exportMap.get(exportedName) || exportedName;

            returnPairs.push(`${exportedName}: ${originalName}`);
            if (exportedName === localName) {
              destructPairs.push(exportedName);
            } else {
              destructPairs.push(`${exportedName}: ${localName}`);
            }
          }

          // Strip ES export statements from the chunk code
          const chunkCode = depChunk.code.replace(/export\s*\{[^}]*\};?/g, '');

          // Wrap in IIFE: chunk variables stay scoped, only requested bindings are returned
          const iifeCode = `const { ${destructPairs.join(', ')} } = (() => {\n${chunkCode}\nreturn { ${returnPairs.join(', ')} };\n})();`;

          entryChunk.code = entryChunk.code.replace(imp.statement, iifeCode);
        }
      }
    }
  };
}

export default defineConfig(({ mode }) => {
  return {
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
          'chat': resolve(__dirname, 'src/chat/chat.html'),
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
      inlineEntryChunks(),
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

            // Swap to red icons for development builds
            if (mode === 'development') {
              const devIconsDir = resolve(__dirname, 'icons-dev');
              const distIconsDir = resolve(distDir, 'icons');
              mkdirSync(distIconsDir, { recursive: true });
              for (const size of ['icon16.png', 'icon48.png', 'icon128.png']) {
                copyFileSync(
                  resolve(devIconsDir, size),
                  resolve(distIconsDir, size)
                );
              }
              console.log('[post-build-cleanup] Replaced icons with red dev variants');
            }
          } catch (e) {
            console.warn('Post-build cleanup error:', e);
          }
        }
      }
    ]
  };
});
