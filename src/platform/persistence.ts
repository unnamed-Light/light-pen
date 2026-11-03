import type { BoardDocument } from "../editor/model/types";

export type SaveStatus = "saved" | "pending" | "saving" | "error";
export interface DocumentBackend {
  persist(document: BoardDocument, path: string | null): Promise<void>;
}

/** A serial, coalescing queue. A receipt never marks a newer edit as saved. */
export class SaveCoordinator {
  status: SaveStatus = "saved";
  error = "";
  path: string | null = null;
  private pending: { document: BoardDocument; path: string | null } | null =
    null;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private firstPending = 0;
  private listeners = new Set<() => void>();
  private version = 0;
  private disposed = false;
  constructor(
    private backend: DocumentBackend,
    private idle: () => boolean = () => true,
    private delay = 650,
  ) {}
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.version;
  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }
  reset(path: string | null) {
    if (this.running || this.pending)
      throw new Error("Сначала сохраните текущую доску.");
    this.path = path;
    this.status = "saved";
    this.error = "";
    this.emit();
  }
  schedule(document: BoardDocument, path = this.path) {
    if (this.disposed) return;
    this.path = path;
    this.pending = { document, path };
    this.status = "pending";
    this.error = "";
    const now = Date.now();
    if (!this.firstPending) this.firstPending = now;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => this.autoFlush(),
      Math.max(0, Math.min(this.delay, 4000 - (now - this.firstPending))),
    );
    this.emit();
  }
  private autoFlush() {
    this.timer = null;
    if (!this.idle()) {
      this.timer = setTimeout(() => this.autoFlush(), 200);
      return;
    }
    void this.flush().catch(() => {
      /* The error is retained and displayed; edits remain pending. */
    });
  }
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.running) {
      await this.running;
      if (this.pending) await this.flush();
      return;
    }
    if (!this.pending) return;
    this.running = this.drain();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }
  private async drain() {
    while (this.pending) {
      const job = this.pending;
      this.pending = null;
      this.status = "saving";
      this.emit();
      try {
        await this.backend.persist(job.document, job.path);
      } catch (error) {
        if (!this.pending) this.pending = job;
        this.status = "error";
        this.error = String(error instanceof Error ? error.message : error);
        this.emit();
        throw error;
      }
    }
    this.firstPending = 0;
    this.status = "saved";
    this.error = "";
    this.emit();
  }
  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }
}
