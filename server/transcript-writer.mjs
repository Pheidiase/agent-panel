// Run by tmux pipe-pane, independently of the web server. Compact BEFORE a
// write would cross the budget, including when a single chunk is oversized.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { codedError } from "./error-codes.mjs";

export const TRANSCRIPT_LIMIT = 16 * 1024 * 1024;
export const TRANSCRIPT_KEEP = 8 * 1024 * 1024;

export class TranscriptWriter {
  constructor(file) {
    this.fd = fs.openSync(file, "a+", 0o600);
    try {
      this.size = fs.fstatSync(this.fd).size;
      if (this.size > TRANSCRIPT_LIMIT) this.compact(Buffer.alloc(0));
    } catch (error) {
      this.close();
      throw error;
    }
  }

  writeAll(data) {
    let offset = 0;
    while (offset < data.length) {
      const written = fs.writeSync(this.fd, data, offset, data.length - offset);
      if (!written) throw codedError("Transkript yazılamadı.", "TRANSCRIPT_WRITE_FAILED");
      offset += written;
      this.size += written;
    }
  }

  compact(chunk) {
    const newest = chunk.subarray(Math.max(0, chunk.length - TRANSCRIPT_KEEP));
    const read = Math.min(this.size, TRANSCRIPT_KEEP - newest.length);
    const previous = Buffer.alloc(read);
    let offset = 0;
    while (offset < read) {
      const count = fs.readSync(this.fd, previous, offset, read - offset, this.size - read + offset);
      if (!count) throw codedError("Transkript okunamadı.", "TRANSCRIPT_READ_FAILED");
      offset += count;
    }
    const tail = Buffer.concat([previous, newest]);
    const cut = tail.indexOf(0x0a);
    fs.ftruncateSync(this.fd, 0);
    this.size = 0;
    this.writeAll(cut >= 0 ? tail.subarray(cut + 1) : tail);
  }

  append(chunk) {
    if (this.size + chunk.length > TRANSCRIPT_LIMIT) this.compact(chunk);
    else this.writeAll(chunk);
  }

  close() {
    fs.closeSync(this.fd);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const writer = new TranscriptWriter(process.argv[2]);
  process.stdin.on("data", chunk => writer.append(chunk));
  process.stdin.on("end", () => writer.close());
}
