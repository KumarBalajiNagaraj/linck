import { strFromU8, unzipSync } from 'fflate';

/**
 * Reads what WhatsApp's "Export chat" actually hands you.
 *
 * - Android, "Include media": a .zip holding `WhatsApp Chat with <group>.txt`
 *   and the photos (`IMG-20260806-WA0012.jpg`).
 * - iOS: a .zip holding `_chat.txt` and the photos
 *   (`00000012-PHOTO-2026-08-06-19-42-10.jpg`).
 * - "Without media": just the .txt.
 *
 * People also unzip it on a laptop and pick the .txt and some photos by hand,
 * so loose files are accepted too. Photos are keyed by bare file name, the
 * way the chat text refers to them.
 */

export interface ChatArchive {
  chatFileName: string;
  chatText: string;
  /** Photos and PDFs by bare file name, as the chat text names them. */
  media: Map<string, File>;
  /** Files that were neither a chat nor a bill image, reported rather than dropped silently. */
  ignored: string[];
}

const TEXT = /\.txt$/i;
const MEDIA = /\.(jpe?g|png|webp|heic|pdf)$/i;
/** A group's export with a month of photos is tens of MB; far beyond that is not a chat export. */
const MAX_UNZIPPED_BYTES = 300 * 1024 * 1024;

const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  pdf: 'application/pdf',
};

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
const isZip = (f: File) => /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed';

function decode(bytes: Uint8Array): string {
  return strFromU8(bytes).replace(/^﻿/, '');
}

export class ChatArchiveError extends Error {}

export async function readChatArchive(files: readonly File[]): Promise<ChatArchive> {
  const chats: { name: string; text: string }[] = [];
  const media = new Map<string, File>();
  const ignored: string[] = [];

  for (const file of files) {
    if (isZip(file)) {
      let total = 0;
      const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
        filter: (f) => {
          const keep = (TEXT.test(f.name) || MEDIA.test(f.name)) && !f.name.startsWith('__MACOSX/');
          if (keep) total += f.originalSize;
          if (!keep && !f.name.endsWith('/')) ignored.push(baseName(f.name));
          return keep && total <= MAX_UNZIPPED_BYTES;
        },
      });
      if (total > MAX_UNZIPPED_BYTES) throw new ChatArchiveError('That archive is far larger than a chat export — it was not read.');
      for (const [path, bytes] of Object.entries(entries)) {
        const name = baseName(path);
        if (TEXT.test(name)) chats.push({ name, text: decode(bytes) });
        else media.set(name, new File([bytes], name, { type: mimeOf(name) }));
      }
    } else if (TEXT.test(file.name)) {
      chats.push({ name: file.name, text: decode(new Uint8Array(await file.arrayBuffer())) });
    } else if (MEDIA.test(file.name)) {
      media.set(file.name, file);
    } else {
      ignored.push(file.name);
    }
  }

  if (chats.length === 0) {
    throw new ChatArchiveError('No chat text found. Export the group with "Export chat" and choose the .zip, or the .txt inside it.');
  }
  // iOS names it _chat.txt; Android "WhatsApp Chat with …". Otherwise the
  // longest text file is the chat — a stray notes.txt is never longer.
  const chat =
    chats.find((c) => c.name === '_chat.txt') ??
    chats.find((c) => /^whatsapp chat/i.test(c.name)) ??
    [...chats].sort((a, b) => b.text.length - a.text.length)[0]!;
  for (const c of chats) if (c !== chat) ignored.push(c.name);

  return { chatFileName: chat.name, chatText: chat.text, media, ignored };
}
