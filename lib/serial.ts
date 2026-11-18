/**
 * Thin wrapper over the Web Serial API so the browser can drive the Uno
 * directly over USB. Chrome / Edge on desktop only, and the page must be on
 * https or localhost.
 */

type SerialPortLike = {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
  getInfo?: () => { usbVendorId?: number; usbProductId?: number };
};

type SerialLike = {
  requestPort(options?: { filters?: unknown[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
};

function serial(): SerialLike | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as unknown as { serial?: SerialLike }).serial ?? null;
}

export function serialSupported(): boolean {
  return serial() !== null;
}

export class SerialLink {
  private port: SerialPortLike | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private partial = '';
  private closing = false;

  onLine?: (line: string) => void;
  onStatus?: (connected: boolean, detail?: string) => void;

  get connected() {
    return this.port !== null;
  }

  async connect(baudRate = 9600) {
    const s = serial();
    if (!s) throw new Error('This browser has no Web Serial API. Use Chrome or Edge on a desktop.');
    const port = await s.requestPort();
    await port.open({ baudRate });
    this.port = port;
    this.closing = false;
    if (port.writable) this.writer = port.writable.getWriter();
    this.onStatus?.(true, baudRate + ' baud');
    void this.readLoop();
  }

  private async readLoop() {
    const port = this.port;
    if (!port?.readable) return;
    const decoder = new TextDecoder();
    try {
      this.reader = port.readable.getReader();
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (!value) continue;
        this.partial += decoder.decode(value, { stream: true });
        const parts = this.partial.split(/\r?\n/);
        this.partial = parts.pop() ?? '';
        for (const line of parts) this.onLine?.(line);
      }
    } catch (err) {
      if (!this.closing) this.onStatus?.(false, String(err));
    } finally {
      try {
        this.reader?.releaseLock();
      } catch {}
      this.reader = null;
    }
  }

  /** Send one command line. The sketch expects a trailing newline. */
  async sendLine(text: string) {
    if (!this.writer) throw new Error('Not connected');
    await this.writer.write(new TextEncoder().encode(text + '\n'));
  }

  async disconnect() {
    this.closing = true;
    try {
      await this.reader?.cancel();
    } catch {}
    try {
      this.writer?.releaseLock();
    } catch {}
    this.writer = null;
    try {
      await this.port?.close();
    } catch {}
    this.port = null;
    this.onStatus?.(false, 'closed');
  }
}
