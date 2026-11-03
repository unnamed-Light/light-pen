import { expect, test } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { Store, passwordHash } from "./store";
import { backupDatabase } from "./backup";
import { SharedBoard } from "../src/collaboration/shared";
import { createDocument } from "../src/editor/model/types";
import { createCollaborationServer } from "./server";
import { api, createRoom, RoomClient } from "../src/collaboration/client";

test("online WAL backup restores users, sessions, grants and room state without changing the source", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightpen-backup-")),
    source = join(dir, "source.sqlite"),
    target = join(dir, "backup.sqlite");
  let store: Store | null = null;
  try {
    store = new Store(source);
    store.db
      .prepare("INSERT INTO users VALUES(?,?,?,?)")
      .run(
        "user",
        "account",
        "Name",
        await passwordHash("test-backup-password"),
      );
    const session = store.session("user"),
      shared = new SharedBoard();
    shared.seed({ ...createDocument(), id: "room" });
    store.db
      .prepare("INSERT INTO rooms VALUES(?,?,?,?,0,?)")
      .run("room", "user", "Board", shared.encode(), Date.now());
    const invite = store.grant("room", "viewer", "Guest", 24);
    await backupDatabase(source, target);
    const restored = new Store(target);
    try {
      expect(restored.user(session)?.login).toBe("account");
      expect(restored.access("room", invite.token)?.role).toBe("viewer");
      const board = new SharedBoard();
      board.apply(
        restored.db.prepare("SELECT state FROM rooms WHERE id=?").get("room")!
          .state as Uint8Array,
      );
      expect(board.snapshot().id).toBe("room");
    } finally {
      restored.close();
    }
    const bytes = await readFile(target);
    await expect(backupDatabase(source, target)).rejects.toThrow();
    expect(await readFile(target)).toEqual(bytes);
    expect(store.user(session)?.login).toBe("account");
  } finally {
    store?.close();
    expect(dirname(resolve(dir))).toBe(resolve(tmpdir()));
    expect(basename(dir).startsWith("lightpen-backup-")).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("public surface rejects foreign origins, unsafe grants and exhausted storage", async () => {
  const app = createCollaborationServer({
      database: ":memory:",
      maxTotalBytes: 10,
    }),
    url = await app.listen();
  try {
    const foreign = await fetch(url + "/health", {
      headers: { Origin: "https://attacker.example" },
    });
    expect(foreign.status).toBe(403);
    await expect(createRoom(url, createDocument())).rejects.toThrow(
      "лимита хранения",
    );
    expect(app.store.db.prepare("SELECT count(*) n FROM rooms").get()!.n).toBe(
      0,
    );
    const landing = await fetch(url + "/join/" + "a".repeat(36));
    expect(landing.headers.get("referrer-policy")).toBe("no-referrer");
    expect(landing.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
  } finally {
    await app.close();
    await app.close();
  }
});

test("queued concurrent clients converge and acknowledgements follow durable validation", async () => {
  const app = createCollaborationServer({ database: ":memory:" }),
    url = await app.listen(),
    clients: RoomClient[] = [];
  try {
    const room = await createRoom(url, createDocument());
    for (let i = 0; i < 6; i++) {
      const grant = await api(
        url,
        `/v1/rooms/${room.id}/invites`,
        "POST",
        room.token,
        { role: "editor" },
      );
      const c = new RoomClient(url, room.id, grant.token, {
        async load() {
          return null;
        },
        async save() {},
      });
      clients.push(c);
      await c.connect();
    }
    const started = performance.now();
    for (const [i, c] of clients.entries()) {
      const before = c.snapshot();
      c.shared.patch(before, { ...before, title: "Title " + i });
    }
    await expect
      .poll(() => clients.every((c) => !c.unconfirmed), { timeout: 15000 })
      .toBe(true);
    await expect
      .poll(() => new Set(clients.map((c) => c.snapshot().title)).size, {
        timeout: 15000,
      })
      .toBe(1);
    console.log(
      "METRIC collab-six-clients-ms",
      Math.round(performance.now() - started),
    );
    const saved = new SharedBoard();
    saved.apply(
      app.store.db.prepare("SELECT state FROM rooms WHERE id=?").get(room.id)!
        .state as Uint8Array,
    );
    expect(saved.snapshot().title).toBe(clients[0].snapshot().title);
  } finally {
    await Promise.all(clients.map((c) => c.close()));
    await app.close();
  }
}, 20000);
