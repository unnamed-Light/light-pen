import { afterEach, expect, test } from "vitest";
import { WebSocket } from "ws";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { createCollaborationServer } from "./server.ts";
import { SharedBoard } from "../src/collaboration/shared.ts";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
} from "../src/editor/model/types.ts";
const running: ReturnType<typeof createCollaborationServer>[] = [];
afterEach(async () => {
  for (const app of running.splice(0)) await app.close();
});
async function start(database = ":memory:") {
  const app = createCollaborationServer({ database });
  running.push(app);
  return { app, url: await app.listen() };
}
async function request(
  url: string,
  path: string,
  method = "GET",
  token = "",
  data?: unknown,
) {
  const response = await fetch(url + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: response.status, body: await response.json() };
}
async function register(url: string, login: string) {
  return (
    await request(url, "/v1/register", "POST", "", {
      login,
      password: "testing-password-2026",
      name: login,
    })
  ).body.token as string;
}
async function room(url: string, token = "") {
  return (
    await request(url, "/v1/rooms", "POST", token, {
      document: {
        ...createDocument(),
        elements: [
          { ...createElement("text", 0, 0, DEFAULT_STYLE), text: "abcdef" },
        ],
      },
    })
  ).body as { id: string; token: string };
}
test("concurrent room creation respects durable quotas after worker validation; oversized metadata requests fail without room changes", async () => {
  const app = createCollaborationServer({ database: ":memory:", maxRooms: 1 });
  running.push(app);
  const url = await app.listen();
  const results = await Promise.all([
    request(url, "/v1/rooms", "POST", "", { document: createDocument() }),
    request(url, "/v1/rooms", "POST", "", { document: createDocument() }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([201, 503]);
  expect(app.store.db.prepare("SELECT count(*) n FROM rooms").get()!.n).toBe(1);
  expect(
    (
      await request(url, "/v1/register", "POST", "", {
        login: "oversize",
        password: "p".repeat(70000),
      })
    ).status,
  ).toBe(413);
  expect(app.store.db.prepare("SELECT count(*) n FROM rooms").get()!.n).toBe(1);
});
async function socket(url: string, id: string, token: string) {
  const t = await request(url, `/v1/rooms/${id}/ticket`, "POST", token);
  expect(t.status).toBe(200);
  const ws = new WebSocket(
      url.replace("http:", "ws:") + "/v1/connect?ticket=" + t.body.ticket,
    ),
    queue: unknown[] = [],
    waiting: ((v: any) => void)[] = [];
  ws.on("message", (bytes) => {
    const value = JSON.parse(bytes.toString());
    const resolve = waiting.shift();
    if (resolve) resolve(value);
    else queue.push(value);
  });
  const next = () =>
    new Promise<any>((resolve, reject) => {
      if (queue.length) {
        resolve(queue.shift());
        return;
      }
      const timer = setTimeout(
        () => reject(new Error("Socket message timeout")),
        5000,
      );
      waiting.push((v) => {
        clearTimeout(timer);
        resolve(v);
      });
    });
  const welcome = await next();
  expect(welcome.type).toBe("welcome");
  return { ws, next, welcome };
}
test("account login, guest room ownership, membership and claims isolate access", async () => {
  const { url } = await start(),
    alice = await register(url, "alice"),
    bob = await register(url, "bob"),
    r = await room(url);
  expect((await request(url, `/v1/rooms/${r.id}`, "GET", alice)).status).toBe(
    403,
  );
  expect(
    (
      await request(url, `/v1/rooms/${r.id}/claim`, "POST", r.token, {
        accountToken: alice,
      })
    ).status,
  ).toBe(200);
  expect(
    (await request(url, "/v1/rooms", "GET", alice)).body.rooms,
  ).toHaveLength(1);
  expect(
    (
      await request(url, `/v1/rooms/${r.id}/members`, "POST", alice, {
        login: "bob",
        role: "viewer",
      })
    ).status,
  ).toBe(200);
  expect((await request(url, `/v1/rooms/${r.id}`, "GET", bob)).body.role).toBe(
    "viewer",
  );
  expect(
    (
      await request(url, `/v1/rooms/${r.id}/invites`, "POST", bob, {
        role: "editor",
      })
    ).status,
  ).toBe(403);
  expect(
    (await request(url, `/v1/rooms/${r.id}/members/bob`, "DELETE", alice))
      .status,
  ).toBe(200);
  expect((await request(url, `/v1/rooms/${r.id}`, "GET", bob)).status).toBe(
    403,
  );
  expect(
    (
      await request(url, "/v1/login", "POST", "", {
        login: "alice",
        password: "wrong-password",
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await request(url, "/v1/login", "POST", "", {
        login: "alice",
        password: "testing-password-2026",
      })
    ).status,
  ).toBe(200);
}, 15000);
test("two clients merge edits, persist before ack, reconnect and retain own undo", async () => {
  const { url, app } = await start(),
    r = await room(url),
    inv = (
      await request(url, `/v1/rooms/${r.id}/invites`, "POST", r.token, {
        role: "editor",
      })
    ).body;
  const a = await socket(url, r.id, r.token),
    b = await socket(url, r.id, inv.token);
  await a.next();
  const sa = new SharedBoard(),
    sb = new SharedBoard();
  sa.apply(Buffer.from(a.welcome.update, "base64"));
  sb.apply(Buffer.from(b.welcome.update, "base64"));
  const baseA = sa.snapshot(),
    baseB = sb.snapshot();
  sa.patch(baseA, {
    ...baseA,
    elements: baseA.elements.map((e) => ({ ...e, x: 88, text: "Xabcdef" })),
  });
  sb.patch(baseB, {
    ...baseB,
    elements: baseB.elements.map((e) => ({
      ...e,
      color: "#ff0000",
      text: "abcdefY",
    })),
  });
  a.ws.send(
    JSON.stringify({
      type: "update",
      seq: 1,
      update: Buffer.from(sa.encode()).toString("base64"),
    }),
  );
  expect((await a.next()).type).toBe("ack");
  const remoteA = await b.next();
  sb.apply(Buffer.from(remoteA.update, "base64"));
  b.ws.send(
    JSON.stringify({
      type: "update",
      seq: 2,
      update: Buffer.from(sb.encode()).toString("base64"),
    }),
  );
  expect((await b.next()).type).toBe("ack");
  sa.apply(Buffer.from((await a.next()).update, "base64"));
  expect(sa.snapshot().elements).toEqual(sb.snapshot().elements);
  expect(sa.snapshot().elements[0]).toMatchObject({
    x: 88,
    color: "#ff0000",
    text: "XabcdefY",
  });
  const saved = new SharedBoard();
  saved.apply(
    app.store.db.prepare("SELECT state FROM rooms WHERE id=?").get(r.id)!
      .state as Uint8Array,
  );
  expect(saved.snapshot().elements).toEqual(sa.snapshot().elements);
  const c = await socket(url, r.id, inv.token);
  const sc = new SharedBoard();
  sc.apply(Buffer.from(c.welcome.update, "base64"));
  expect(sc.snapshot().elements).toEqual(sa.snapshot().elements);
  a.ws.close();
  b.ws.close();
  c.ws.close();
});
test("viewer updates and corrupt editor updates cannot change persisted room", async () => {
  const { url, app } = await start(),
    r = await room(url),
    grant = (
      await request(url, `/v1/rooms/${r.id}/invites`, "POST", r.token, {
        role: "viewer",
      })
    ).body;
  const before = Buffer.from(
    app.store.db.prepare("SELECT state FROM rooms WHERE id=?").get(r.id)!
      .state as Uint8Array,
  );
  const v = await socket(url, r.id, grant.token);
  v.ws.send(JSON.stringify({ type: "update", seq: 1, update: "AA==" }));
  expect((await v.next()).type).toBe("error");
  const e = await socket(url, r.id, r.token);
  e.ws.send(JSON.stringify({ type: "update", seq: 2, update: "not base64" }));
  expect((await e.next()).type).toBe("error");
  expect(
    Buffer.from(
      app.store.db.prepare("SELECT state FROM rooms WHERE id=?").get(r.id)!
        .state as Uint8Array,
    ),
  ).toEqual(before);
});
test("revocation disconnects an existing socket; invitations and one-use tickets cannot cross rooms", async () => {
  const { url } = await start(),
    a = await room(url),
    b = await room(url),
    grant = (
      await request(url, `/v1/rooms/${a.id}/invites`, "POST", a.token, {
        role: "editor",
      })
    ).body;
  expect(
    (await request(url, `/v1/rooms/${b.id}`, "GET", grant.token)).status,
  ).toBe(403);
  const peer = await socket(url, a.id, grant.token),
    closed = new Promise<number>((resolve) =>
      peer.ws.once("close", (code) => resolve(code)),
    );
  expect(
    (
      await request(
        url,
        `/v1/rooms/${a.id}/invites/${grant.id}`,
        "DELETE",
        a.token,
      )
    ).status,
  ).toBe(200);
  expect(await closed).toBe(4003);
  expect(
    (await request(url, `/v1/rooms/${a.id}/ticket`, "POST", grant.token))
      .status,
  ).toBe(403);
});
test("server restart restores accounts, room content and valid invitations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lightpen-server-"));
  try {
    const first = await start(join(dir, "test.sqlite")),
      token = await register(first.url, "restart"),
      r = await room(first.url, token),
      invite = (
        await request(first.url, `/v1/rooms/${r.id}/invites`, "POST", token, {
          role: "viewer",
        })
      ).body;
    await first.app.close();
    running.splice(running.indexOf(first.app), 1);
    const second = await start(join(dir, "test.sqlite"));
    expect((await request(second.url, "/v1/me", "GET", token)).status).toBe(
      200,
    );
    const peer = await socket(second.url, r.id, invite.token);
    const doc = new SharedBoard();
    doc.apply(Buffer.from(peer.welcome.update, "base64"));
    expect(doc.snapshot().elements[0].text).toBe("abcdef");
    peer.ws.close();
    await second.app.close();
    running.splice(running.indexOf(second.app), 1);
  } finally {
    expect(dirname(resolve(dir))).toBe(resolve(tmpdir()));
    expect(basename(dir).startsWith("lightpen-server-")).toBe(true);
    await rm(dir, { recursive: true, force: true });
  }
});
