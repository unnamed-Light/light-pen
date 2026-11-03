import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import * as Y from "yjs";
import {
  Store,
  secret,
  digest,
  passwordHash,
  passwordMatches,
} from "./store.ts";
import type { Access } from "./store.ts";
import { ValidationPool } from "./validation-pool.ts";

const MAX_MESSAGE = 48 * 1024 * 1024,
  MAX_STATE = 64 * 1024 * 1024;
type Peer = {
  socket: WebSocket;
  access: Access;
  token: string;
  id: string;
  alive: boolean;
  name: string;
  window: number;
  count: number;
  traffic: number;
  trafficStart: number;
};
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function assert(
  value: unknown,
  status: number,
  message: string,
): asserts value {
  if (!value) throw new HttpError(status, message);
}
const encode = (data: Uint8Array) => Buffer.from(data).toString("base64");
function decode(data: unknown) {
  assert(
    typeof data === "string" &&
      data.length <= MAX_MESSAGE * 1.4 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(data),
    400,
    "Повреждён пакет синхронизации.",
  );
  return new Uint8Array(Buffer.from(data, "base64"));
}
export function createCollaborationServer(options: {
  database: string;
  origins?: string[];
  allowRegistration?: boolean;
  maxRooms?: number;
  maxTotalBytes?: number;
  trustProxy?: boolean;
}) {
  const store = new Store(options.database),
    peers = new Set<Peer>(),
    tickets = new Map<
      string,
      { token: string; access: Access; expires: number }
    >(),
    limits = new Map<string, { start: number; count: number }>();
  const validation = new ValidationPool();
  const queues = new Map<string, Promise<void>>();
  let queued = 0,
    queuedBytes = 0,
    creating = 0,
    activeBodies = 0,
    incomingBytes = 0,
    stopping = false;
  let closePromise: Promise<void> | null = null;
  const totalLimit = options.maxTotalBytes ?? 1024 * 1024 * 1024;
  const clientIp = (req: IncomingMessage) =>
    options.trustProxy && typeof req.headers["x-forwarded-for"] === "string"
      ? req.headers["x-forwarded-for"].split(",")[0].trim()
      : (req.socket.remoteAddress ?? "unknown");
  const storageBytes = () =>
    Number(
      store.db
        .prepare("SELECT coalesce(sum(length(state)),0) size FROM rooms")
        .get()!.size,
    );
  const origins = new Set(
    options.origins ?? [
      "http://tauri.localhost",
      "https://tauri.localhost",
      "tauri://localhost",
      "http://127.0.0.1:1420",
    ],
  );
  const bearer = (req: IncomingMessage) =>
    (req.headers.authorization ?? "").replace(/^Bearer /, "");
  const access = (req: IncomingMessage, room: string) => {
    const a = store.access(room, bearer(req));
    assert(a, 403, "Нет доступа к доске или приглашение отозвано.");
    return a;
  };
  const owner = (req: IncomingMessage, room: string) => {
    const a = access(req, room);
    assert(a.role === "owner", 403, "Действие доступно владельцу.");
    return a;
  };
  const send = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(data));
  };
  async function bodyBytes(req: IncomingMessage, max = 64 * 1024) {
    assert(activeBodies < 8, 503, "Сервис занят. Повторите запрос позже.");
    activeBodies++;
    let size = 0;
    const parts: Buffer[] = [];
    try {
      for await (const c of req.iterator({ destroyOnReturn: false })) {
        size += c.length;
        incomingBytes += c.length;
        assert(size <= max, 413, "Запрос слишком большой.");
        assert(
          incomingBytes <= 64 * 1024 * 1024,
          503,
          "Сервис занят. Повторите запрос позже.",
        );
        parts.push(c);
      }
      return Buffer.concat(parts);
    } finally {
      activeBodies--;
      incomingBytes -= size;
    }
  }
  async function body(req: IncomingMessage) {
    const bytes = await bodyBytes(req);
    try {
      return JSON.parse(bytes.toString());
    } catch {
      throw new HttpError(400, "Ожидался JSON.");
    }
  }
  function rate(key: string, max: number) {
    const now = Date.now(),
      v = limits.get(key);
    if (!v || now - v.start > 60_000) {
      limits.set(key, { start: now, count: 1 });
      return;
    }
    assert(
      ++v.count <= max,
      429,
      "Слишком много запросов. Повторите через минуту.",
    );
  }
  const server = createServer(async (req, res) => {
    try {
      assert(!stopping, 503, "Сервис завершает работу.");
      const origin = req.headers.origin;
      if (origin) {
        assert(origins.has(origin), 403, "Источник запроса не разрешён.");
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Authorization,Content-Type",
        );
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET,POST,DELETE,OPTIONS",
        );
      }
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost"),
        path = url.pathname,
        token = bearer(req),
        ip = clientIp(req);
      rate("http:" + ip, 240);
      if (path === "/health" && req.method === "GET") {
        send(res, 200, { status: "ok", protocol: 1 });
        return;
      }
      if (
        req.method === "GET" &&
        (path === "/" || /^\/join\/[a-f0-9-]{36}$/i.test(path))
      ) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
          "Content-Security-Policy":
            "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        });
        res.end(
          `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Light Pen — совместная доска</title><style>body{font:18px/1.6 system-ui,sans-serif;max-width:640px;margin:12vh auto;padding:24px;background:#f3f3f3;color:#242424}main{padding:32px;background:white;border-radius:12px}a{color:#0f6cbd}h1{line-height:1.2}</style><main><h1>Light Pen</h1><p>Совместная доска в настольном приложении.</p><p>Если вам передали приглашение, скопируйте полный адрес этой страницы. В Light Pen откройте «Совместная работа», вставьте приглашение и нажмите «Подключиться».</p><p>Секрет приглашения остаётся после знака # и не передаётся этой странице.</p><a href="https://github.com/unnamed-Light/light-pen/releases" rel="noreferrer">Версии приложения на GitHub</a></main></html>`,
        );
        return;
      }
      if (
        ["/v1/register", "/v1/login"].includes(path) &&
        req.method === "POST"
      ) {
        rate("auth:" + ip, 20);
        const b = await body(req);
        assert(
          typeof b.login === "string" &&
            /^[a-z0-9_.-]{3,64}$/i.test(b.login) &&
            typeof b.password === "string",
          400,
          "Логин: 3–64 латинских символа, цифры, точка, дефис.",
        );
        const login = b.login.toLowerCase();
        let user = store.db
          .prepare("SELECT * FROM users WHERE login=?")
          .get(login) as
          | { id: string; login: string; name: string; password: string }
          | undefined;
        if (path.endsWith("register")) {
          assert(
            options.allowRegistration !== false,
            403,
            "Регистрация отключена.",
          );
          assert(!user, 409, "Логин уже занят.");
          const name =
            typeof b.name === "string" ? b.name.trim().slice(0, 80) : login;
          const hash = await passwordHash(b.password);
          user = {
            id: randomUUID(),
            login,
            name: name || login,
            password: hash,
          };
          try {
            store.db
              .prepare("INSERT INTO users VALUES(?,?,?,?)")
              .run(user.id, user.login, user.name, user.password);
          } catch {
            throw new HttpError(409, "Логин уже занят.");
          }
        } else {
          // A missing account still performs a KDF, avoiding a cheap timing oracle.
          const hash = user?.password ?? "0".repeat(32) + ":" + "0".repeat(128);
          const matches = await passwordMatches(b.password, hash);
          assert(user && matches, 401, "Неверный логин или пароль.");
        }
        send(res, 200, {
          token: store.session(user.id),
          user: { id: user.id, login: user.login, name: user.name },
        });
        return;
      }
      if (path === "/v1/me" && req.method === "GET") {
        const user = store.user(token);
        assert(user, 401, "Войдите в аккаунт.");
        send(res, 200, { user });
        return;
      }
      if (path === "/v1/logout" && req.method === "POST") {
        store.db
          .prepare("DELETE FROM sessions WHERE hash=?")
          .run(digest(token));
        for (const p of peers)
          if (p.token === token) p.socket.close(4003, "Session ended");
        send(res, 200, { ok: true });
        return;
      }
      if (path === "/v1/rooms" && req.method === "GET") {
        const user = store.user(token);
        assert(user, 401, "Войдите в аккаунт.");
        const rooms = store.db
          .prepare(
            "SELECT DISTINCT r.id,r.title,r.version,r.updated,CASE WHEN r.owner=? THEN 'owner' ELSE m.role END role FROM rooms r LEFT JOIN members m ON m.room=r.id AND m.user_id=? WHERE r.owner=? OR m.user_id=? ORDER BY r.updated DESC LIMIT 200",
          )
          .all(user.id, user.id, user.id, user.id);
        send(res, 200, { rooms });
        return;
      }
      if (path === "/v1/rooms" && req.method === "POST") {
        rate("create:" + ip, 12);
        assert(
          creating < 2,
          503,
          "Сервис занят созданием досок. Повторите позже.",
        );
        const user = store.user(token);
        assert(
          !token || user,
          401,
          "Сеанс истёк. Войдите в аккаунт перед созданием доски.",
        );
        assert(
          Number(store.db.prepare("SELECT count(*) n FROM rooms").get()!.n) <
            (options.maxRooms ?? 10000),
          503,
          "Сервер достиг лимита досок.",
        );
        creating++;
        try {
          const source = await bodyBytes(req, MAX_MESSAGE),
            id = randomUUID();
          const { state, title } = await validation.run({
            source,
            room: id,
            maxState: MAX_STATE,
          });
          assert(!stopping, 503, "Сервис завершает работу.");
          assert(
            !token || store.user(token),
            401,
            "Сеанс истёк. Войдите в аккаунт перед созданием доски.",
          );
          assert(
            Number(store.db.prepare("SELECT count(*) n FROM rooms").get()!.n) <
              (options.maxRooms ?? 10000),
            503,
            "Сервер достиг лимита досок.",
          );
          assert(state.length <= MAX_STATE, 413, "Доска слишком большая.");
          assert(
            storageBytes() + state.length <= totalLimit,
            507,
            "Сервер достиг лимита хранения.",
          );
          if (user)
            assert(
              Number(
                store.db
                  .prepare("SELECT count(*) n FROM rooms WHERE owner=?")
                  .get(user.id)!.n,
              ) < 100,
              429,
              "Достигнут лимит досок аккаунта.",
            );
          store.db
            .prepare("INSERT INTO rooms VALUES(?,?,?,?,0,?)")
            .run(id, user?.id ?? null, title, state, Date.now());
          const grant = user
            ? null
            : store.grant(id, "owner", "Владелец", 24 * 365);
          store.log(id, "created", user?.id ?? grant!.id);
          send(res, 201, {
            id,
            title,
            token: user ? token : grant!.token,
            role: "owner",
          });
        } finally {
          creating--;
        }
        return;
      }
      const match = path.match(/^\/v1\/rooms\/([a-z0-9-]{36})(?:\/(.*))?$/i);
      if (match) {
        const room = match[1],
          action = match[2] ?? "";
        if (!action && req.method === "GET") {
          const a = access(req, room),
            r = store.db
              .prepare("SELECT id,title,version,updated FROM rooms WHERE id=?")
              .get(room);
          send(res, 200, { ...r, role: a.role });
          return;
        }
        if (action === "ticket" && req.method === "POST") {
          const a = access(req, room),
            ticket = secret();
          tickets.set(digest(ticket), {
            token,
            access: a,
            expires: Date.now() + 30_000,
          });
          send(res, 200, { ticket });
          return;
        }
        if (action === "invites" && req.method === "POST") {
          const a = owner(req, room),
            b = await body(req);
          assert(
            ["editor", "viewer"].includes(b.role),
            400,
            "Разрешены роли editor и viewer.",
          );
          const hours = Number(b.hours ?? 24);
          assert(
            Number.isFinite(hours) && hours >= 1 && hours <= 720,
            400,
            "Срок: 1–720 часов.",
          );
          const label =
            typeof b.label === "string" ? b.label.slice(0, 80) : "Гость";
          const grant = store.grant(room, b.role, label, hours);
          store.log(room, "invite-created", a.principal);
          send(res, 201, {
            ...grant,
            role: b.role,
            expires: Date.now() + hours * 3600_000,
          });
          return;
        }
        if (action === "invites" && req.method === "GET") {
          owner(req, room);
          send(res, 200, {
            invites: store.db
              .prepare(
                "SELECT hash id,role,expires,revoked,label FROM grants WHERE room=? AND role!='owner'",
              )
              .all(room),
          });
          return;
        }
        if (action.startsWith("invites/") && req.method === "DELETE") {
          const a = owner(req, room),
            id = action.slice(8);
          store.db
            .prepare(
              "UPDATE grants SET revoked=1 WHERE hash=? AND room=? AND role!='owner'",
            )
            .run(id, room);
          for (const p of peers)
            if (p.access.room === room && p.access.grant === id)
              p.socket.close(4003, "Access revoked");
          store.log(room, "invite-revoked", a.principal);
          send(res, 200, { ok: true });
          return;
        }
        if (action === "claim" && req.method === "POST") {
          const a = owner(req, room),
            b = await body(req),
            user = store.user(String(b.accountToken ?? ""));
          assert(user, 401, "Войдите в аккаунт.");
          const row = store.db
            .prepare("SELECT owner FROM rooms WHERE id=?")
            .get(room)!;
          assert(
            !row.owner || row.owner === user.id,
            409,
            "У доски уже есть владелец аккаунта.",
          );
          store.db.exec("BEGIN IMMEDIATE");
          try {
            store.db
              .prepare("UPDATE rooms SET owner=? WHERE id=?")
              .run(user.id, room);
            store.db
              .prepare(
                "UPDATE grants SET revoked=1 WHERE room=? AND role='owner'",
              )
              .run(room);
            store.db.exec("COMMIT");
          } catch (e) {
            store.db.exec("ROLLBACK");
            throw e;
          }
          for (const p of peers)
            if (
              p.access.room === room &&
              p.access.grant !== "account" &&
              p.access.role === "owner"
            )
              p.socket.close(4003, "Ownership moved to account");
          store.log(room, "claimed", a.principal);
          send(res, 200, { ok: true });
          return;
        }
        if (action === "members" && req.method === "POST") {
          const a = owner(req, room),
            b = await body(req);
          assert(
            ["editor", "viewer"].includes(b.role) &&
              typeof b.login === "string",
            400,
            "Укажите логин и роль.",
          );
          const user = store.db
            .prepare("SELECT id FROM users WHERE login=?")
            .get(b.login.toLowerCase());
          assert(user, 404, "Аккаунт не найден.");
          store.db
            .prepare(
              "INSERT INTO members VALUES(?,?,?) ON CONFLICT(room,user_id) DO UPDATE SET role=excluded.role",
            )
            .run(room, user.id, b.role);
          for (const p of peers)
            if (p.access.room === room && p.access.principal === user.id)
              p.socket.close(4001, "Role changed");
          store.log(room, "member-updated", a.principal);
          send(res, 200, { ok: true });
          return;
        }
        if (action === "members" && req.method === "GET") {
          owner(req, room);
          send(res, 200, {
            members: store.db
              .prepare(
                "SELECT u.login,u.name,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.room=?",
              )
              .all(room),
          });
          return;
        }
        if (action.startsWith("members/") && req.method === "DELETE") {
          const a = owner(req, room),
            login = decodeURIComponent(action.slice(8)),
            user = store.db
              .prepare("SELECT id FROM users WHERE login=?")
              .get(login);
          if (user) {
            store.db
              .prepare("DELETE FROM members WHERE room=? AND user_id=?")
              .run(room, user.id);
            for (const p of peers)
              if (p.access.room === room && p.access.principal === user.id)
                p.socket.close(4003, "Access revoked");
          }
          store.log(room, "member-removed", a.principal);
          send(res, 200, { ok: true });
          return;
        }
      }
      throw new HttpError(404, "Неизвестный запрос.");
    } catch (error) {
      const e = error as Error;
      if (!req.complete) {
        res.setHeader("Connection", "close");
        res.once("finish", () => req.destroy());
      }
      send(res, error instanceof HttpError ? error.status : 400, {
        error: e.message.slice(0, 300),
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.maxConnections = 1024;
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE,
    perMessageDeflate: false,
  });
  server.on("upgrade", (req, socket, head) => {
    try {
      if (req.headers.origin && !origins.has(req.headers.origin))
        throw new Error("origin");
      rate("ws:" + clientIp(req), 60);
      const url = new URL(req.url ?? "/", "http://localhost"),
        key = digest(url.searchParams.get("ticket") ?? ""),
        ticket = tickets.get(key);
      tickets.delete(key);
      if (
        url.pathname !== "/v1/connect" ||
        !ticket ||
        ticket.expires < Date.now() ||
        !store.access(ticket.access.room, ticket.token) ||
        peers.size >= 500
      )
        throw new Error("ticket");
      wss.handleUpgrade(req, socket, head, (ws) => {
        const p: Peer = {
          socket: ws,
          access: ticket.access,
          token: ticket.token,
          id: randomUUID(),
          alive: true,
          name: ticket.access.name,
          window: Date.now(),
          count: 0,
          traffic: 0,
          trafficStart: Date.now(),
        };
        peers.add(p);
        try {
          connect(p);
        } catch {
          peers.delete(p);
          ws.close(4002, "Stored board could not be loaded");
        }
      });
    } catch {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
    }
  });
  const broadcast = (room: string, data: unknown, except?: Peer) => {
    const packet = JSON.stringify(data);
    for (const p of peers)
      if (
        p !== except &&
        p.access.room === room &&
        p.socket.readyState === WebSocket.OPEN
      ) {
        if (p.socket.bufferedAmount > MAX_STATE) {
          p.socket.close(4008, "Slow connection");
          continue;
        }
        p.socket.send(packet);
      }
  };
  function connect(p: Peer) {
    const row = store.db
      .prepare("SELECT state,version FROM rooms WHERE id=?")
      .get(p.access.room)!;
    const vector = encode(
      Y.encodeStateVectorFromUpdate(row.state as Uint8Array),
    );
    p.socket.send(
      JSON.stringify({
        type: "welcome",
        peerId: p.id,
        role: p.access.role,
        accessKind: p.access.grant === "account" ? "account" : "invitation",
        update: encode(row.state as Uint8Array),
        vector,
        version: row.version,
        peers: [...peers]
          .filter((q) => q !== p && q.access.room === p.access.room)
          .map((q) => ({ id: q.id, name: q.name, role: q.access.role })),
      }),
    );
    broadcast(
      p.access.room,
      { type: "peer", id: p.id, name: p.name, role: p.access.role },
      p,
    );
    p.socket.on("pong", () => {
      p.alive = true;
    });
    p.socket.on("close", () => {
      peers.delete(p);
      broadcast(p.access.room, { type: "left", id: p.id });
    });
    p.socket.on("error", () => {
      p.socket.terminate();
    });
    p.socket.on("message", (bytes) => {
      try {
        if (stopping) return;
        if (Date.now() - p.window > 1000) {
          p.window = Date.now();
          p.count = 0;
        }
        assert(++p.count <= 90, 429, "Слишком много пакетов.");
        if (Date.now() - p.trafficStart > 60000) {
          p.trafficStart = Date.now();
          p.traffic = 0;
        }
        p.traffic += bytes.toString().length;
        assert(
          p.traffic <= 96 * 1024 * 1024,
          429,
          "Превышен объём передачи. Сохраните локальную копию.",
        );
        const a = store.access(p.access.room, p.token);
        assert(a, 403, "Доступ отозван.");
        p.access = a;
        const packet = JSON.parse(bytes.toString());
        if (packet.type === "presence") {
          const cursor = packet.cursor;
          assert(
            !cursor ||
              (Number.isFinite(cursor.x) &&
                Number.isFinite(cursor.y) &&
                Math.abs(cursor.x) <= 1e9 &&
                Math.abs(cursor.y) <= 1e9),
            400,
            "Неверная позиция.",
          );
          const selected = Array.isArray(packet.selected)
            ? packet.selected
                .filter(
                  (s: unknown) => typeof s === "string" && s.length <= 128,
                )
                .slice(0, 100)
            : [];
          broadcast(
            a.room,
            {
              type: "presence",
              id: p.id,
              name: p.name,
              role: a.role,
              cursor: cursor ? { x: cursor.x, y: cursor.y } : null,
              selected,
            },
            p,
          );
          return;
        }
        assert(
          packet.type === "update" &&
            Number.isSafeInteger(packet.seq) &&
            packet.seq >= 0,
          400,
          "Неизвестный пакет.",
        );
        assert(a.role !== "viewer", 403, "Только просмотр.");
        const update = decode(packet.update);
        assert(
          queued < 64 && queuedBytes + update.length <= 64 * 1024 * 1024,
          503,
          "Сервис занят. Изменения остаются на устройстве.",
        );
        queued++;
        queuedBytes += update.length;
        const seq = packet.seq;
        const previous = queues.get(a.room) ?? Promise.resolve();
        const task = previous
          .catch(() => {})
          .then(async () => {
            if (stopping) return;
            const beforeAccess = store.access(a.room, p.token);
            assert(
              beforeAccess && beforeAccess.role !== "viewer",
              403,
              "Доступ к редактированию отозван.",
            );
            const row = store.db
              .prepare("SELECT state,version FROM rooms WHERE id=?")
              .get(a.room)!;
            const result = await validation.run({
              state: row.state as Uint8Array,
              update,
              room: a.room,
              maxState: MAX_STATE,
            });
            const afterAccess = store.access(a.room, p.token);
            assert(
              afterAccess && afterAccess.role !== "viewer",
              403,
              "Доступ к редактированию отозван.",
            );
            const state = result.state,
              changed = !Buffer.from(row.state as Uint8Array).equals(
                Buffer.from(state),
              ),
              version = Number(row.version) + (changed ? 1 : 0);
            assert(
              storageBytes() -
                (row.state as Uint8Array).length +
                state.length <=
                totalLimit,
              507,
              "Сервер достиг лимита хранения. Локальная копия сохранена.",
            );
            if (changed)
              store.db
                .prepare(
                  "UPDATE rooms SET state=?,version=?,title=?,updated=? WHERE id=?",
                )
                .run(state, version, result.title, Date.now(), a.room);
            if (p.socket.readyState === WebSocket.OPEN)
              p.socket.send(JSON.stringify({ type: "ack", seq, version }));
            if (changed)
              broadcast(
                a.room,
                { type: "update", update: encode(update), version },
                p,
              );
          })
          .catch((error) => {
            rejectUpdate(p, error);
          })
          .finally(() => {
            queued--;
            queuedBytes -= update.length;
            if (queues.get(a.room) === task) queues.delete(a.room);
          });
        queues.set(a.room, task);
      } catch (error) {
        rejectUpdate(p, error);
      }
    });
  }
  function rejectUpdate(p: Peer, error: unknown) {
    if (p.socket.readyState !== WebSocket.OPEN) return;
    p.socket.send(
      JSON.stringify({
        type: "error",
        error: (error as Error).message.slice(0, 300),
      }),
    );
    p.socket.close(
      error instanceof HttpError && error.status === 403 ? 4003 : 4002,
      "Rejected update",
    );
  }
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [key, t] of tickets) if (t.expires < now) tickets.delete(key);
    for (const [key, v] of limits)
      if (now - v.start > 120000) limits.delete(key);
    for (const p of peers) {
      if (!store.access(p.access.room, p.token)) {
        p.socket.close(4003, "Access expired");
        continue;
      }
      if (!p.alive) {
        p.socket.terminate();
        continue;
      }
      p.alive = false;
      p.socket.ping();
    }
  }, 15000);
  heartbeat.unref();
  return {
    server,
    store,
    async listen(port = 0, host = "127.0.0.1") {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      return `http://${host}:${typeof address === "object" && address ? address.port : port}`;
    },
    close() {
      return (closePromise ??= (async () => {
        stopping = true;
        clearInterval(heartbeat);
        for (const p of peers) p.socket.terminate();
        await validation.close();
        await Promise.all([...queues.values()]);
        await new Promise<void>((resolve) => wss.close(() => resolve()));
        await new Promise<void>((resolve) => server.close(() => resolve()));
        store.close();
      })());
    },
  };
}
