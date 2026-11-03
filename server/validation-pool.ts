import { Worker } from "node:worker_threads";
export interface ValidationResult {
  state: Uint8Array;
  title: string;
}
type Input = {
  room: string;
  maxState: number;
} & ({ state: Uint8Array; update: Uint8Array } | { source: Uint8Array });
type Job = {
  id: number;
  input: Input;
  resolve: (r: ValidationResult) => void;
  reject: (e: Error) => void;
};
type Slot = {
  worker: Worker;
  ready: boolean;
  job: Job | null;
  timer: ReturnType<typeof setTimeout> | null;
};
/** Untrusted CRDT decoding is bounded by a separate V8 heap and wall-clock deadline. */
export class ValidationPool {
  private slots: Slot[] = [];
  private queue: Job[] = [];
  private next = 0;
  private closed = false;
  constructor(
    private size = 2,
    private deadline = 10000,
  ) {}
  run(input: Input): Promise<ValidationResult> {
    if (this.closed)
      return Promise.reject(new Error("Сервер завершает работу."));
    if (this.queue.length >= 32)
      return Promise.reject(
        new Error("Сервис перегружен. Изменения остаются на устройстве."),
      );
    while (this.slots.length < this.size) this.spawn();
    return new Promise((resolve, reject) => {
      this.queue.push({ id: ++this.next, input, resolve, reject });
      this.dispatch();
    });
  }
  private spawn() {
    const worker = new Worker(
      new URL("./validator-worker.mjs", import.meta.url),
      {
        resourceLimits: {
          maxOldGenerationSizeMb: 192,
          maxYoungGenerationSizeMb: 32,
          stackSizeMb: 4,
        },
      },
    );
    const slot: Slot = { worker, ready: false, job: null, timer: null };
    this.slots.push(slot);
    slot.timer = setTimeout(
      () =>
        this.failed(
          slot,
          new Error("Не удалось запустить обработчик синхронизации."),
        ),
      this.deadline,
    );
    worker.on("message", (message) => {
      if (message.ready) {
        if (slot.timer) clearTimeout(slot.timer);
        slot.timer = null;
        slot.ready = true;
        this.dispatch();
        return;
      }
      const job = slot.job;
      if (!job || message.id !== job.id) return;
      if (slot.timer) clearTimeout(slot.timer);
      slot.timer = null;
      slot.job = null;
      if (message.error) job.reject(new Error(message.error));
      else job.resolve({ state: message.state, title: message.title });
      this.dispatch();
    });
    worker.on("error", (error) =>
      this.failed(
        slot,
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
    worker.on("exit", (code) => {
      if (!this.closed && this.slots.includes(slot))
        this.failed(slot, new Error("Обработчик завершился: " + code));
    });
  }
  private failed(slot: Slot, error: Error) {
    if (!this.slots.includes(slot)) return;
    if (slot.timer) clearTimeout(slot.timer);
    slot.job?.reject(error);
    slot.job = null;
    this.slots.splice(this.slots.indexOf(slot), 1);
    void slot.worker.terminate();
    if (!this.closed && this.queue.length) {
      this.spawn();
      this.dispatch();
    }
  }
  private dispatch() {
    for (const slot of this.slots) {
      if (!slot.ready || slot.job || !this.queue.length) continue;
      const job = this.queue.shift()!;
      slot.job = job;
      slot.timer = setTimeout(
        () =>
          this.failed(
            slot,
            new Error(
              "Обработка изменения превысила время. Локальная копия сохранена.",
            ),
          ),
        this.deadline,
      );
      slot.worker.postMessage({ id: job.id, ...job.input });
    }
  }
  async close() {
    this.closed = true;
    for (const job of this.queue.splice(0))
      job.reject(new Error("Сервер завершает работу."));
    for (const slot of this.slots) {
      if (slot.timer) clearTimeout(slot.timer);
      slot.job?.reject(new Error("Сервер завершает работу."));
    }
    await Promise.all(this.slots.map((s) => s.worker.terminate()));
    this.slots = [];
  }
}
