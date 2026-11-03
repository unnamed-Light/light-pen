import { afterEach, expect, test } from "vitest";
import { createCollaborationServer } from "../../server/server";
import {
  RoomClient,
  createRoom,
  api,
  invitation,
  parseInvitation,
  serviceUrl,
} from "./client";
import type { RoomCache } from "./client";
import { bindRoom } from "./binding";
import { Editor } from "../editor/editor";
import { insertTableRow, insertTableColumn } from "../editor/model/data";
import { mergeUpdates } from "yjs";
import { SharedBoard } from "./shared";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
} from "../editor/model/types";
class MemoryCache implements RoomCache {
  values = new Map<string, Uint8Array>();
  async load(key: string) {
    return this.values.get(key) ?? null;
  }
  async save(key: string, state: Uint8Array) {
    this.values.set(key, new Uint8Array(state));
  }
}
test("incremental cache flush retries failed packets and never needs full-state encoding for each edit", async () => {
  const { url, room } = await setup();
  let fail = true;
  const packets: Uint8Array[] = [];
  const cache: RoomCache = {
    async load() {
      return null;
    },
    async save() {
      throw new Error("Full state writes are not used");
    },
    async append(_key, updates) {
      if (fail) {
        fail = false;
        throw new Error("Disk temporarily unavailable");
      }
      packets.push(...updates);
    },
  };
  const c = new RoomClient(url, room.id, room.token, cache);
  cleanup.push(() => c.close());
  await c.connect();
  await expect(c.flushCache()).rejects.toThrow("Disk temporarily unavailable");
  const before = c.snapshot();
  c.shared.patch(before, { ...before, title: "Правка сохранена" });
  await c.flushCache();
  const restored = new SharedBoard();
  restored.apply(mergeUpdates(packets));
  expect(restored.snapshot().title).toBe("Правка сохранена");
  expect(restored.snapshot().elements).toEqual(c.snapshot().elements);
  restored.destroy();
});
test("a failed cache read is never overwritten by an empty CRDT during connection cleanup", async () => {
  const { url, room } = await setup();
  let saves = 0;
  const c = new RoomClient(url, room.id, room.token, {
    async load() {
      throw new Error("Cache temporarily unavailable");
    },
    async save() {
      saves++;
    },
  });
  await expect(c.connect()).rejects.toThrow("Cache temporarily unavailable");
  await c.close();
  expect(saves).toBe(0);
});
test("an invalid account token never silently creates an anonymous room", async () => {
  const { url, server } = await setup();
  const count = server.store.db.prepare("SELECT count(*) n FROM rooms").get()!
    .n;
  await expect(
    createRoom(url, createDocument(), "invalid-session"),
  ).rejects.toThrow("Сеанс истёк");
  expect(server.store.db.prepare("SELECT count(*) n FROM rooms").get()!.n).toBe(
    count,
  );
});
test("expired invitations stop reconnect attempts and retain the cached local copy", async () => {
  const { url, room, server } = await setup(),
    g = await api(url, `/v1/rooms/${room.id}/invites`, "POST", room.token, {
      role: "editor",
    });
  server.store.db.prepare("UPDATE grants SET expires=0 WHERE hash=?").run(g.id);
  const c = new RoomClient(url, room.id, g.token, new MemoryCache());
  cleanup.push(() => c.close());
  await expect(c.connect()).rejects.toThrow();
  expect(c.status).toBe("revoked");
});
test("nested groups synchronize as format four and remote edits survive the grouping author's undo", async () => {
  const { url, room } = await setup(),
    a = await peer(url, room.id, room.token),
    b = await peer(url, room.id, room.token);
  a.editor.commit(
    [
      ...a.editor.elements,
      createElement("rectangle", 300, 200, DEFAULT_STYLE),
      createElement("rectangle", 600, 200, DEFAULT_STYLE),
    ],
    "Shapes",
  );
  await expect.poll(() => b.editor.elements.length, { timeout: 5000 }).toBe(3);
  a.editor.selected = new Set(a.editor.elements.slice(0, 2).map((e) => e.id));
  a.editor.group();
  a.editor.selectAll();
  a.editor.group();
  await expect
    .poll(() => b.editor.elements[0].groupPath?.length, { timeout: 5000 })
    .toBe(2);
  b.editor.commit(
    b.editor.elements.map((e, i) => (i === 2 ? { ...e, fill: "#fff1a8" } : e)),
    "Remote fill",
  );
  await expect
    .poll(() => a.editor.elements[2].fill, { timeout: 5000 })
    .toBe("#fff1a8");
  a.editor.undo();
  await expect
    .poll(() => b.editor.elements[0].groupPath?.length, { timeout: 5000 })
    .toBe(1);
  expect(b.editor.elements[2].fill).toBe("#fff1a8");
});
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const server = createCollaborationServer({ database: ":memory:" }),
    url = await server.listen();
  cleanup.push(() => server.close());
  const document = {
      ...createDocument(),
      elements: [
        { ...createElement("text", 0, 0, DEFAULT_STYLE), text: "abcdef" },
      ],
    },
    room = await createRoom(url, document);
  return { server, url, room };
}
test("a rejected local command restores valid content and leaves synchronization and undo usable", async () => {
  const { url, room } = await setup(),
    a = await peer(url, room.id, room.token),
    b = await peer(url, room.id, room.token),
    errors: string[] = [];
  a.editor.reportError = (message) => errors.push(message);
  const original = structuredClone(a.editor.elements);
  expect(() =>
    a.editor.commit(
      [a.editor.elements[0], a.editor.elements[0]],
      "Invalid duplicate",
    ),
  ).not.toThrow();
  expect(a.editor.elements).toEqual(original);
  expect(errors[0]).toContain("Повторяющиеся");
  expect(a.c.status).toBe("online");
  a.editor.commit(
    a.editor.elements.map((e) => ({ ...e, x: 222 })),
    "Valid move",
  );
  await expect.poll(() => b.editor.elements[0].x, { timeout: 5000 }).toBe(222);
  a.editor.undo();
  await expect
    .poll(() => b.editor.elements[0].x, { timeout: 5000 })
    .toBe(original[0].x);
});
test("server workers persist simultaneous structural table edits and own undo without erasing the other participant", async () => {
  const { url, room } = await setup(),
    a = await peer(url, room.id, room.token),
    b = await peer(url, room.id, room.token);
  a.editor.addStructured("table", [
    ["Название", "Цена"],
    ["abcdef", "10"],
  ]);
  const id = a.editor.objectDraft!.id;
  a.editor.saveObjectDraft(a.editor.objectDraft!);
  await expect
    .poll(() => b.editor.elements.find((e) => e.id === id)?.cells?.length, {
      timeout: 5000,
    })
    .toBe(2);
  const tableA = structuredClone(a.editor.elements.find((e) => e.id === id)!),
    tableB = structuredClone(b.editor.elements.find((e) => e.id === id)!);
  const row = structuredClone(insertTableRow(tableA, 1));
  row.cells![1][0] = "Новая строка";
  row.cells![2][0] = "Xabcdef";
  const col = insertTableColumn(tableB, 1);
  col.cells![0][1] = "Поле";
  col.cells![1][2] = "42";
  a.editor.saveObjectDraft(row);
  b.editor.saveObjectDraft(col);
  await expect
    .poll(() => a.editor.elements.find((e) => e.id === id)?.cells?.[2]?.[2], {
      timeout: 5000,
    })
    .toBe("42");
  await expect
    .poll(() => b.editor.elements.find((e) => e.id === id)?.cells?.[2]?.[0], {
      timeout: 5000,
    })
    .toBe("Xabcdef");
  a.editor.undo();
  await expect
    .poll(() => b.editor.elements.find((e) => e.id === id)?.cells?.length, {
      timeout: 5000,
    })
    .toBe(2);
  expect(b.editor.elements.find((e) => e.id === id)?.cells).toEqual([
    ["Название", "Поле", "Цена"],
    ["abcdef", "", "42"],
  ]);
  await expect
    .poll(() => a.c.unconfirmed || b.c.unconfirmed, { timeout: 5000 })
    .toBe(false);
  const fresh = await peer(url, room.id, room.token);
  expect(fresh.editor.elements.find((e) => e.id === id)?.cells).toEqual(
    b.editor.elements.find((e) => e.id === id)?.cells,
  );
  expect(fresh.editor.elements.find((e) => e.id === id)?.grid).toEqual(
    b.editor.elements.find((e) => e.id === id)?.grid,
  );
});
async function peer(
  url: string,
  room: string,
  token: string,
  cache: RoomCache = new MemoryCache(),
) {
  const c = new RoomClient(url, room, token, cache);
  cleanup.push(() => c.close());
  await c.connect();
  const editor = new Editor(),
    binding = bindRoom(editor, c);
  cleanup.push(() => binding.close());
  return { c, editor, binding };
}
test("HTTPS policy and invitations keep bearer secrets in fragments and reject unsafe endpoints", () => {
  const token = "a".repeat(43),
    room = "a".repeat(36),
    link = invitation("https://boards.example.org", room, token);
  expect(new URL(link).search).toBe("");
  expect(new URL(link).hash).toBe("#" + token);
  expect(parseInvitation(link)).toEqual({
    service: "https://boards.example.org",
    room,
    token,
  });
  for (const url of [
    "http://boards.example.org",
    "file:///tmp",
    "https://user:password@example.org",
    "https://example.org/path",
  ])
    expect(() => serviceUrl(url)).toThrow();
  expect(() =>
    parseInvitation("https://boards.example.org/other/" + room + "#" + token),
  ).toThrow();
});
test("editor binding merges different fields and own undo cannot revert another participant", async () => {
  const { url, room } = await setup(),
    a = await peer(url, room.id, room.token),
    g = await api(url, `/v1/rooms/${room.id}/invites`, "POST", room.token, {
      role: "editor",
    }),
    b = await peer(url, room.id, g.token);
  a.editor.commit(
    a.editor.elements.map((e) => ({ ...e, x: 120 })),
    "Move",
  );
  await expect.poll(() => b.editor.elements[0].x, { timeout: 5000 }).toBe(120);
  b.editor.commit(
    b.editor.elements.map((e) => ({ ...e, color: "#ff0000" })),
    "Color",
  );
  await expect
    .poll(() => a.editor.elements[0].color, { timeout: 5000 })
    .toBe("#ff0000");
  a.editor.undo();
  await expect.poll(() => b.editor.elements[0].x, { timeout: 5000 }).toBe(0);
  expect(b.editor.elements[0].color).toBe("#ff0000");
  a.editor.redo();
  await expect.poll(() => b.editor.elements[0].x, { timeout: 5000 }).toBe(120);
  await expect.poll(() => a.c.unconfirmed, { timeout: 5000 }).toBe(false);
});
test("remote text packets wait for the active edit, then merge without losing either insertion", async () => {
  const { url, room } = await setup(),
    a = await peer(url, room.id, room.token),
    g = await api(url, `/v1/rooms/${room.id}/invites`, "POST", room.token, {
      role: "editor",
    }),
    b = await peer(url, room.id, g.token);
  const original = b.editor.elements[0];
  b.editor.editing = { element: original, isNew: false, value: "abcdefY" };
  a.editor.commit(
    a.editor.elements.map((e) => ({ ...e, text: "Xabcdef" })),
    "Text",
  );
  await expect.poll(() => a.c.unconfirmed, { timeout: 5000 }).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(b.editor.elements[0].text).toBe("abcdef");
  b.editor.commitText();
  await expect
    .poll(() => a.editor.elements[0].text, { timeout: 5000 })
    .toBe("XabcdefY");
  await expect
    .poll(() => b.editor.elements[0].text, { timeout: 5000 })
    .toBe("XabcdefY");
});
test("viewer cannot commit, revoked editor becomes read-only, and leaving preserves the local board", async () => {
  const { url, room } = await setup(),
    g = await api(url, `/v1/rooms/${room.id}/invites`, "POST", room.token, {
      role: "viewer",
    }),
    v = await peer(url, room.id, g.token);
  v.editor.commit([], "Delete");
  expect(v.editor.elements).toHaveLength(1);
  expect(v.editor.readOnly).toBe(true);
  await api(url, `/v1/rooms/${room.id}/invites/${g.id}`, "DELETE", room.token);
  await expect.poll(() => v.c.status, { timeout: 5000 }).toBe("revoked");
  expect(v.editor.elements).toHaveLength(1);
  await v.binding.close();
  expect(v.editor.readOnly).toBe(false);
  v.editor.commit([], "Local delete");
  expect(v.editor.elements).toHaveLength(0);
});
test("cached CRDT changes survive a client restart and synchronize on reconnect", async () => {
  const { url, room } = await setup(),
    cache = new MemoryCache(),
    a = await peer(url, room.id, room.token, cache);
  await a.c.close();
  a.editor.commit(
    a.editor.elements.map((e) => ({ ...e, x: 555 })),
    "Offline move",
  );
  await cache.save(a.c.key, a.c.shared.encode());
  await a.binding.close();
  const b = await peer(url, room.id, room.token, cache);
  expect(b.editor.elements[0].x).toBe(555);
  await expect.poll(() => b.c.unconfirmed, { timeout: 5000 }).toBe(false);
  const observer = await peer(url, room.id, room.token);
  expect(observer.editor.elements[0].x).toBe(555);
});
