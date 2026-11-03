export interface RoomCache {
  load(key: string): Promise<Uint8Array | null>;
  save(key: string, state: Uint8Array): Promise<void>;
  append?(key: string, updates: Uint8Array[]): Promise<void>;
}
type Base = { state: Uint8Array; through: number; generation: string };
type Delta = { seq: number; room: string; update: Uint8Array };
const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const complete = (t: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onabort = () => reject(t.error ?? new Error("Запись кэша отменена."));
    t.onerror = () => reject(t.error);
  });
function baseOf(value: Base | Uint8Array | undefined): Base | null {
  if (!value) return null;
  return "state" in value
    ? { ...value, state: new Uint8Array(value.state) }
    : { state: new Uint8Array(value), through: 0, generation: "legacy" };
}
export async function mergeCachedUpdates(
  updates: Uint8Array[],
): Promise<Uint8Array> {
  if (updates.length === 1) return new Uint8Array(updates[0]);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./cache-worker.ts", import.meta.url), {
      type: "module",
    });
    const finish = () => {
      clearTimeout(timeout);
      worker.terminate();
    };
    const timeout = setTimeout(() => {
      finish();
      reject(new Error("Объединение сетевого черновика превысило время."));
    }, 15000);
    worker.onmessage = (e) => {
      finish();
      if (e.data.error) reject(new Error(e.data.error));
      else resolve(new Uint8Array(e.data.state));
    };
    worker.onerror = () => {
      finish();
      reject(new Error("Не удалось объединить сетевой черновик."));
    };
    const copies = updates.map((u) => new Uint8Array(u));
    worker.postMessage(
      copies,
      copies.map((u) => u.buffer),
    );
  });
}
/** Append small CRDT packets; full merges happen off the drawing thread. */
export class BrowserRoomCache implements RoomCache {
  constructor(private merge = mergeCachedUpdates) {}
  private db: Promise<IDBDatabase> | null = null;
  private compacting = new Map<string, Promise<void>>();
  private open() {
    return (this.db ??= new Promise((resolve, reject) => {
      const r = indexedDB.open("lightpen-collaboration", 2);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains("rooms"))
          db.createObjectStore("rooms");
        if (!db.objectStoreNames.contains("updates")) {
          const store = db.createObjectStore("updates", {
            keyPath: "seq",
            autoIncrement: true,
          });
          store.createIndex("room", "room");
        }
        if (!db.objectStoreNames.contains("stats"))
          db.createObjectStore("stats");
      };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };
        resolve(db);
      };
      r.onerror = () => {
        this.db = null;
        reject(r.error);
      };
    }));
  }
  private async read(key: string) {
    const db = await this.open(),
      tx = db.transaction(["rooms", "updates"]),
      done = complete(tx);
    const [value, deltas] = await Promise.all([
      request(tx.objectStore("rooms").get(key)),
      request(tx.objectStore("updates").index("room").getAll(key)),
    ]);
    await done;
    const base = baseOf(value);
    return {
      base,
      deltas: (deltas as Delta[]).filter((d) => d.seq > (base?.through ?? 0)),
    };
  }
  async load(key: string) {
    const { base, deltas } = await this.read(key),
      packets = [
        ...(base ? [base.state] : []),
        ...deltas.map((d) => new Uint8Array(d.update)),
      ];
    return packets.length ? this.merge(packets) : null;
  }
  async append(key: string, updates: Uint8Array[]) {
    if (!updates.length) return;
    const db = await this.open(),
      tx = db.transaction(["updates", "stats"], "readwrite"),
      done = complete(tx);
    const stats = tx.objectStore("stats");
    let compact = false;
    const old = stats.get(key);
    old.onsuccess = () => {
      const count = (old.result?.count ?? 0) + updates.length,
        bytes =
          (old.result?.bytes ?? 0) +
          updates.reduce((n, u) => n + u.byteLength, 0);
      stats.put({ count, bytes }, key);
      compact = count >= 300 || bytes >= 4 * 1024 * 1024;
    };
    for (const update of updates)
      tx.objectStore("updates").add({
        room: key,
        update: new Uint8Array(update),
      });
    await done;
    if (compact)
      void this.compact(key).catch(() => {
        /* Original packets remain intact; a later append retries. */
      });
  }
  async save(key: string, state: Uint8Array) {
    const db = await this.open(),
      tx = db.transaction(["rooms", "updates", "stats"], "readwrite"),
      done = complete(tx),
      store = tx.objectStore("updates");
    const keys = store.index("room").getAllKeys(key);
    keys.onsuccess = () => {
      for (const id of keys.result) store.delete(id);
      tx.objectStore("rooms").put(
        {
          state: new Uint8Array(state),
          through: keys.result.reduce<number>(
            (n, key) => Math.max(n, Number(key)),
            0,
          ),
          generation: crypto.randomUUID(),
        },
        key,
      );
      tx.objectStore("stats").put({ count: 0, bytes: 0 }, key);
    };
    await done;
  }
  compact(key: string): Promise<void> {
    const existing = this.compacting.get(key);
    if (existing) return existing;
    const work = this.doCompact(key).finally(() => this.compacting.delete(key));
    this.compacting.set(key, work);
    return work;
  }
  private async doCompact(key: string) {
    const { base, deltas } = await this.read(key);
    if (!deltas.length) return;
    const state = await this.merge([
      ...(base ? [base.state] : []),
      ...deltas.map((d) => new Uint8Array(d.update)),
    ]);
    const through = deltas.reduce(
      (n, d) => Math.max(n, d.seq),
      base?.through ?? 0,
    );
    const db = await this.open(),
      tx = db.transaction(["rooms", "updates", "stats"], "readwrite"),
      done = complete(tx),
      rooms = tx.objectStore("rooms"),
      current = rooms.get(key);
    current.onsuccess = () => {
      const now = baseOf(current.result);
      if (
        (now?.generation ?? null) !== (base?.generation ?? null) ||
        (now?.through ?? 0) !== (base?.through ?? 0)
      )
        return;
      rooms.put({ state, through, generation: crypto.randomUUID() }, key);
      for (const delta of deltas) tx.objectStore("updates").delete(delta.seq);
      const stats = tx.objectStore("stats"),
        old = stats.get(key);
      old.onsuccess = () =>
        stats.put(
          {
            count: Math.max(0, (old.result?.count ?? 0) - deltas.length),
            bytes: Math.max(
              0,
              (old.result?.bytes ?? 0) -
                deltas.reduce((n, d) => n + d.update.byteLength, 0),
            ),
          },
          key,
        );
    };
    await done;
  }
}
