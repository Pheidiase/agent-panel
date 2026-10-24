import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PanelError } from "./session-store.mjs";

export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const types = [
  { ext: "png", mime: "image/png", magic: [0x89, 0x50, 0x4e, 0x47] },
  { ext: "jpg", mime: "image/jpeg", magic: [0xff, 0xd8, 0xff] },
  { ext: "gif", mime: "image/gif", magic: [0x47, 0x49, 0x46, 0x38] },
  { ext: "webp", mime: "image/webp", magic: [0x52, 0x49, 0x46, 0x46] },
];
export class ImageUploads {
  constructor(dir, { now = Date.now, maxFiles = 200, maxBytes = 256 * 1024 * 1024 } = {}) {
    Object.assign(this, { dir, now, maxFiles, maxBytes });
  }
  sweep() {
    if (!fs.existsSync(this.dir)) return;
    for (const item of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!item.isFile()) continue;
      const file = path.join(this.dir, item.name);
      if (this.now() - fs.statSync(file).mtimeMs > UPLOAD_TTL_MS) fs.unlinkSync(file);
    }
  }
  save(body, mime) {
    const kind = Buffer.isBuffer(body) && types.find(t => t.mime === mime?.split(";")[0]);
    if (!kind || body.length < 16 || !kind.magic.every((b, i) => body[i] === b)
      || (kind.ext === "webp" && body.toString("ascii", 8, 12) !== "WEBP"))
      throw new PanelError(400, "Yalnızca png, jpg, gif veya webp resim yüklenebilir (en fazla 10 MB).");
    if (body.length > 10 * 1024 * 1024) throw new PanelError(413, "Resim 10 MB sınırını aşıyor.");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const files = fs.readdirSync(this.dir, { withFileTypes: true }).filter(item => item.isFile());
    const bytes = files.reduce((total, item) => total + fs.statSync(path.join(this.dir, item.name)).size, 0);
    if (files.length >= this.maxFiles || bytes + body.length > this.maxBytes)
      throw new PanelError(413, "Resim yükleme kapasitesi doldu. Eski yüklemelerin süresinin dolmasını bekle.");
    const file = path.join(this.dir, `${this.now()}-${crypto.randomUUID()}.${kind.ext}`);
    fs.writeFileSync(file, body, { mode: 0o600, flag: "wx" });
    return file;
  }
}
