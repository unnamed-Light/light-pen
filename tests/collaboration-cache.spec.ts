import { test, expect } from "@playwright/test";
test("IndexedDB packet log migrates legacy cache, merges in a worker and retains writes made during compaction", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  const result = await page.evaluate(async () => {
    const cachePath = "/src/collaboration/cache.ts",
      sharedPath = "/src/collaboration/shared.ts";
    const { BrowserRoomCache, mergeCachedUpdates } = await import(cachePath),
      { SharedBoard } = await import(sharedPath);
    const board = new SharedBoard();
    board.seed({
      ...window.__LIGHT_PEN_TEST__!.editor.document,
      id: "cache-qa",
    });
    const original = board.snapshot();
    await new Promise<void>((resolve, reject) => {
      const r = indexedDB.open("lightpen-collaboration", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("rooms");
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const db = r.result,
          t = db.transaction("rooms", "readwrite");
        t.objectStore("rooms").put(board.encode(), "qa");
        t.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
    const cache = new BrowserRoomCache(),
      packets: Uint8Array[] = [];
    board.doc.on("update", (u: Uint8Array) => packets.push(new Uint8Array(u)));
    const change = (title: string) => {
      const before = board.snapshot();
      board.patch(before, { ...before, title });
    };
    change("Первый пакет");
    await cache.append("qa", packets.splice(0));
    let release!: () => void, started!: () => void;
    let gate = new Promise<void>((r) => (release = r)),
      seen = new Promise<void>((r) => (started = r));
    const paused = new BrowserRoomCache(async (updates: Uint8Array[]) => {
      started();
      await gate;
      return mergeCachedUpdates(updates);
    });
    const compaction = paused.compact("qa");
    await seen;
    change("Пакет во время объединения");
    await cache.append("qa", packets.splice(0));
    release();
    await compaction;
    const restored = new SharedBoard();
    restored.apply(await cache.load("qa"));
    const simultaneous = restored.snapshot().title;
    change("Пакет до замены");
    await cache.append("qa", packets.splice(0));
    gate = new Promise<void>((r) => (release = r));
    seen = new Promise<void>((r) => (started = r));
    const second = paused.compact("qa");
    await seen;
    const replacement = new SharedBoard();
    replacement.seed({ ...original, title: "Новая полная копия" });
    await cache.save("qa", replacement.encode());
    release();
    await second;
    const final = new SharedBoard();
    final.apply(await cache.load("qa"));
    return {
      simultaneous,
      final: final.snapshot().title,
      objects: final.snapshot().elements.length,
      expectedObjects: original.elements.length,
    };
  });
  expect(result.simultaneous).toBe("Пакет во время объединения");
  expect(result.final).toBe("Новая полная копия");
  expect(result.objects).toBe(result.expectedObjects);
});
