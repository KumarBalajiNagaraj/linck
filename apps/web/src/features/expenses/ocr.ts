/**
 * Reads the text off a bill photo, in the browser.
 *
 * Tesseract is loaded only when a photo is actually attached — it is several
 * megabytes of WebAssembly and language data, and nobody who never uploads a
 * bill should download it. Each line keeps the engine's own confidence, so a
 * value read off a line it doubted can never be proposed as certain.
 *
 * The worker, core and English model are served from this app's own origin
 * under `/ocr/` (see `ocrAssets.ts`), never from a CDN. The URLs are made
 * absolute because the worker runs from a blob: URL, against which a relative
 * path resolves to nothing.
 *
 * At cutover this moves behind the extraction service, which can use a
 * stronger model for handwriting; the parse that follows it does not change.
 */

export interface OcrResult {
  text: string;
  /** 0–100, one per line of `text`. */
  lineConfidence: number[];
  engine: string;
}

export async function readBillImage(file: File, onProgress?: (share: number) => void): Promise<OcrResult> {
  const { createWorker, OEM } = await import('tesseract.js');
  const at = (path: string) => new URL(path, document.baseURI).href;
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: at('/ocr/worker.min.js'),
    corePath: at('/ocr/core'),
    langPath: at('/ocr/lang'),
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress?.(m.progress);
    },
  });
  try {
    const { data } = await worker.recognize(file, {}, { text: true, blocks: true });
    const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
    if (lines.length > 0) {
      return {
        text: lines.map((l) => l.text.replace(/\n$/, '')).join('\n'),
        lineConfidence: lines.map((l) => l.confidence),
        engine: 'tesseract.js (eng)',
      };
    }
    const text = data.text ?? '';
    return { text, lineConfidence: text.split('\n').map(() => data.confidence), engine: 'tesseract.js (eng)' };
  } finally {
    await worker.terminate();
  }
}
