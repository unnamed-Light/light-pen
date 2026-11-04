import type { Editor } from "../editor/editor";

export interface ReviewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export interface ReviewContext {
  workspaceId: string;
  pageId: string;
}

/** Personal reading progress. It never enters document history or a shared room. */
export class FrameReview {
  private identity = "local";
  private key = "";
  private viewed = new Set<string>();
  private cache = new Map<string, Set<string>>();

  constructor(
    private context: () => ReviewContext,
    private changed: () => void = () => {},
    private storage: ReviewStorage | null = defaultStorage(),
  ) {}

  private current() {
    const context = this.context();
    const key = `lightpen.review.v1.${encodeURIComponent(
      JSON.stringify([context.workspaceId, context.pageId, this.identity]),
    )}`;
    if (key !== this.key) {
      this.key = key;
      let values = this.cache.get(key);
      if (!values) {
        values = new Set();
        try {
          const saved: unknown = JSON.parse(this.storage?.getItem(key) ?? "[]");
          if (Array.isArray(saved))
            for (const id of saved.slice(0, 100_000))
              if (typeof id === "string" && id.length > 0 && id.length <= 128)
                values.add(id);
        } catch {
          // A damaged preference must never prevent opening a document.
        }
        this.cache.set(key, values);
      }
      this.viewed = values;
    }
    return this.viewed;
  }

  has(id: string) {
    return this.current().has(id);
  }

  ids(): ReadonlySet<string> {
    return this.current();
  }

  list() {
    return [...this.current()];
  }

  mark(ids: readonly string[], viewed = true) {
    if (ids.some((id) => typeof id !== "string" || !id || id.length > 128))
      throw Error("Некорректный идентификатор фрейма.");
    const values = this.current();
    let modified = false;
    for (const id of ids) {
      if (viewed ? !values.has(id) : values.has(id)) {
        viewed ? values.add(id) : values.delete(id);
        modified = true;
      }
    }
    if (modified) this.persist();
    return this.list();
  }

  clear() {
    if (!this.current().size) return [];
    this.viewed.clear();
    this.persist();
    return [];
  }

  setIdentity(identity: string) {
    if (!identity || identity.length > 512)
      throw Error("Некорректный профиль просмотра.");
    if (identity === this.identity) return;
    this.identity = identity;
    this.current();
    this.changed();
  }

  private persist() {
    try {
      if (this.viewed.size)
        this.storage?.setItem(this.key, JSON.stringify([...this.viewed]));
      else this.storage?.removeItem(this.key);
    } catch {
      // Keep this session usable if the personal preference store is full.
    }
    this.changed();
  }
}

function defaultStorage(): ReviewStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

const stores = new WeakMap<Editor, FrameReview>();
export function reviewFor(editor: Editor) {
  let store = stores.get(editor);
  if (!store) {
    store = new FrameReview(
      () => ({
        workspaceId: editor.document.id,
        pageId: editor.activePageId ?? "main",
      }),
      () => {
        editor.emit("overlay");
        editor.emit("ui");
      },
    );
    stores.set(editor, store);
  }
  return store;
}
