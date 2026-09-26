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

/** One OCR engine kept open across many photos — a WhatsApp import reads dozens. */
export interface BillReader {
  read: (file: File, onProgress?: (share: number) => void) => Promise<OcrResult>;
  close: () => Promise<void>;
}

const ENGINE = 'tesseract.js (eng)';

export async function openBillReader(): Promise<BillReader> {
  const { createWorker, OEM } = await import('tesseract.js');
  const at = (path: string) => new URL(path, document.baseURI).href;
  // The logger is fixed when the worker is created, so progress is routed to
  // whichever read is running now.
  let report: ((share: number) => void) | undefined;
  const worker = await createWorker('eng', OEM.LSTM_ONLY, {
    workerPath: at('/ocr/worker.min.js'),
    corePath: at('/ocr/core'),
    langPath: at('/ocr/lang'),
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') report?.(m.progress);
    },
  });
  return {
    read: async (file, onProgress) => {
      report = onProgress;
      try {
        const { data } = await worker.recognize(file, {}, { text: true, blocks: true });
        const lines = (data.blocks ?? []).flatMap((b) => b.paragraphs.flatMap((p) => p.lines));
        if (lines.length > 0) {
          return {
            text: lines.map((l) => l.text.replace(/\n$/, '')).join('\n'),
            lineConfidence: lines.map((l) => l.confidence),
            engine: ENGINE,
          };
        }
        const text = data.text ?? '';
        return { text, lineConfidence: text.split('\n').map(() => data.confidence), engine: ENGINE };
      } finally {
        report = undefined;
      }
    },
    close: async () => {
      await worker.terminate();
    },
  };
}

/** Read a single photo with an engine opened for it and closed after. */
export async function readBillImage(file: File, onProgress?: (share: number) => void): Promise<OcrResult> {
  const reader = await openBillReader();
  try {
    return await reader.read(file, onProgress);
  } finally {
    await reader.close();
  }
}
