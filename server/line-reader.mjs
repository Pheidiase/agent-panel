// Scan each incoming byte once; only join fragments when a line is complete.
export class LineReader {
  constructor(limit) {
    this.limit = limit;
    this.reset();
  }

  reset() {
    this.parts = [];
    this.bytes = 0;
  }

  push(chunk, onLine) {
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(0x0a, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      this.bytes += part.length;
      if (this.bytes > this.limit) {
        this.reset();
        return false;
      }
      if (part.length) this.parts.push(part);
      if (end < 0) return true;
      const line = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.bytes);
      this.reset();
      if (line.length && onLine(line) === false) return true;
      start = end + 1;
    }
    return true;
  }
}
