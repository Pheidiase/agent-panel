// Keep streamed clear/redraw bursts together, but never hold up a key's echo.
// xterm already batches parsing/rendering after writes; the extra stream delay
// is only useful while the terminal is producing output without user input.
export class TerminalOutputBuffer {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private chunks: string[] = [];
  private size = 0;
  private interactiveUntil = -Infinity;
  private disposed = false;

  constructor(private write: (data: string) => void, private now = () => performance.now()) {}

  input() {
    this.interactiveUntil = this.now() + 250;
    this.flush();
  }

  push(data: string) {
    if (this.disposed || !data) return;
    this.chunks.push(data); this.size += data.length;
    if (this.size >= 262144 || this.now() < this.interactiveUntil) this.flush();
    else if (this.timer === undefined) this.timer = setTimeout(() => this.flush(), 24);
  }

  private flush() {
    clearTimeout(this.timer); this.timer = undefined;
    const data = this.chunks.join("");
    this.chunks = []; this.size = 0;
    if (!this.disposed && data) this.write(data);
  }

  dispose() {
    this.disposed = true;
    this.flush();
  }
}
