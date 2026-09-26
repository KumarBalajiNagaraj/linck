import { createReadStream, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { Plugin } from 'vite';

/**
 * Serves the OCR engine from this app's own origin, under `/ocr/`.
 *
 * tesseract.js otherwise pulls its worker, its WebAssembly core and the
 * English model from cdn.jsdelivr.net the first time a bill is read. An ERP
 * whose bill capture silently depends on a third-party CDN being reachable
 * from the yard office is one firewall rule away from "capture is broken", so
 * the three files ship with the build instead — ~7 MB, fetched only when
 * someone actually attaches a bill photo.
 *
 * Only the LSTM cores are shipped: `ocr.ts` runs OEM 1 (LSTM only), which is
 * all tesseract.js picks between when handed a core directory.
 */
const require = createRequire(import.meta.url);

function assets(): { url: string; file: string }[] {
  const worker = require.resolve('tesseract.js/dist/worker.min.js');
  const core = dirname(require.resolve('tesseract.js-core/package.json', { paths: [dirname(require.resolve('tesseract.js/package.json'))] }));
  const lang = dirname(require.resolve('@tesseract.js-data/eng/package.json'));
  return [
    { url: 'ocr/worker.min.js', file: worker },
    { url: 'ocr/core/tesseract-core-simd-lstm.wasm.js', file: join(core, 'tesseract-core-simd-lstm.wasm.js') },
    { url: 'ocr/core/tesseract-core-lstm.wasm.js', file: join(core, 'tesseract-core-lstm.wasm.js') },
    { url: 'ocr/lang/eng.traineddata.gz', file: join(lang, '4.0.0_best_int', 'eng.traineddata.gz') },
  ];
}

export function ocrAssets(): Plugin {
  let outDir = 'dist';
  return {
    name: 'linck-ocr-assets',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    configureServer(server) {
      const files = new Map(assets().map((a) => [`/${a.url}`, a.file]));
      server.middlewares.use((req, res, next) => {
        const file = req.url ? files.get(req.url.split('?')[0]!) : undefined;
        if (!file) return next();
        res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    writeBundle() {
      for (const a of assets()) {
        if (!existsSync(a.file)) throw new Error(`OCR asset missing: ${a.file}`);
        const target = join(outDir, a.url);
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(a.file, target);
      }
    },
  };
}
