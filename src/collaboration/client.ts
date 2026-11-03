import { SharedBoard, REMOTE } from "./shared";
import type { BoardDocument, Vec } from "../editor/model/types";
import { BrowserRoomCache } from "./cache";
import type { RoomCache } from "./cache";
export { BrowserRoomCache } from "./cache";
export type { RoomCache } from "./cache";
export type Role = "owner" | "editor" | "viewer";
export class ServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export interface Peer {
  id: string;
  name: string;
  role: Role;
  cursor?: Vec | null;
  selected?: string[];
}
export function serviceUrl(value: string) {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", ""].includes(url.pathname) ||
    !(url.protocol === "https:" || (url.protocol === "http:" && loopback))
  )
    throw new Error(
      "Укажите HTTPS-адрес сервиса. HTTP доступен только на этом компьютере.",
    );
  return url.origin;
}
export async function api<T = any>(
  server: string,
  path: string,
  method = "GET",
  token = "",
  body?: unknown,
): Promise<T> {
  const response = await fetch(serviceUrl(server) + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
    credentials: "omit",
    redirect: "error",
  });
  const data = await response.json();
  if (!response.ok)
    throw new ServiceError(response.status, data.error ?? "Сервис недоступен.");
  return data;
}
export function invitation(server: string, room: string, token: string) {
  return serviceUrl(server) + "/join/" + room + "#" + token;
}
export function parseInvitation(value: string): {
  service: string;
  room: string;
  token: string;
} {
  let data;
  try {
    const text = value.trim();
    if (text.startsWith("{")) data = JSON.parse(text);
    else {
      const url = new URL(text);
      data = {
        service: url.origin,
        room: url.pathname.split("/").at(-1),
        token: url.hash.slice(1),
      };
      if (!url.pathname.startsWith("/join/")) throw new Error();
    }
  } catch {
    throw new Error("Вставьте приглашение Light Pen целиком.");
  }
  if (
    typeof data.room !== "string" ||
    !/^[a-f0-9-]{36}$/i.test(data.room) ||
    typeof data.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(data.token)
  )
    throw new Error("Повреждено приглашение.");
  return {
    service: serviceUrl(data.service),
    room: data.room,
    token: data.token,
  };
}
const encode = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
};
const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export class RoomClient {
  readonly shared = new SharedBoard();
  role: Role = "viewer";
  accessKind: "account" | "invitation" | "unknown" = "unknown";
  status: "connecting" | "online" | "offline" | "revoked" | "error" =
    "connecting";
  error = "";
  version = 0;
  peers = new Map<string, Peer>();
  private socket: WebSocket | null = null;
  private stopped = false;
  private seq = 0;
  private pending = new Set<number>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private retry = 0;
  private loaded = false;
  private ready = false;
  private deferred: { update: string; version: number }[] = [];
  private versionUi = 0;
  private connection: Promise<void> | null = null;
  deferRemote = () => false;
  private welcomeTask: (() => void) | null = null;
  private closing: Promise<void> | null = null;
  private pendingCache: Uint8Array[] = [];
  private writingCache: Promise<void> | null = null;
  readonly key: string;
  constructor(
    readonly server: string,
    readonly room: string,
    readonly token: string,
    private cache: RoomCache = new BrowserRoomCache(),
  ) {
    this.server = serviceUrl(server);
    this.key = this.server + "/" + room;
    this.shared.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (this.loaded && !this.stopped)
        this.pendingCache.push(new Uint8Array(update));
      this.saveSoon();
      if (origin !== REMOTE && this.ready && this.role !== "viewer")
        this.sendUpdate(update);
      this.emit();
    });
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.versionUi;
  private emit() {
    this.versionUi++;
    for (const fn of this.listeners) fn();
  }
  get unconfirmed() {
    return this.pending.size > 0 || this.status !== "online";
  }
  private saveSoon() {
    if (!this.loaded || this.stopped) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flushCache().catch((e) => {
        this.error = "Не удалось сохранить сетевой черновик: " + String(e);
        this.emit();
      });
    }, 150);
  }
  async connect() {
    if (this.connection) return this.connection;
    this.connection = this.open();
    try {
      await this.connection;
    } finally {
      this.connection = null;
    }
  }
  private async open() {
    if (this.stopped) return;
    this.status = "connecting";
    this.emit();
    try {
      if (!this.loaded) {
        const data = await this.cache.load(this.key);
        if (data) this.shared.apply(data);
        this.loaded = true;
      }
      const { ticket } = await api<{ ticket: string }>(
        this.server,
        `/v1/rooms/${this.room}/ticket`,
        "POST",
        this.token,
      );
      if (this.stopped) return;
      const url =
        this.server.replace(/^http/, "ws") +
        "/v1/connect?ticket=" +
        encodeURIComponent(ticket);
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(url);
        this.socket = socket;
        let welcomed = false;
        const timeout = setTimeout(() => {
          socket.close();
          reject(new Error("Сервис не ответил на подключение."));
        }, 20000);
        socket.onmessage = (e) => {
          if (this.socket !== socket) return;
          try {
            const p = JSON.parse(String(e.data));
            if (p.type === "welcome") {
              clearTimeout(timeout);
              const accept = () => {
                if (
                  this.stopped ||
                  this.socket !== socket ||
                  socket.readyState !== WebSocket.OPEN
                )
                  return;
                this.role = p.role;
                this.accessKind =
                  p.accessKind === "account" || p.accessKind === "invitation"
                    ? p.accessKind
                    : "unknown";
                this.version = p.version;
                this.shared.apply(decode(p.update));
                this.ready = true;
                welcomed = true;
                this.status = "online";
                this.error = "";
                this.retry = 0;
                this.pending.clear();
                this.peers = new Map(
                  p.peers.map((peer: Peer) => [peer.id, peer]),
                );
                if (this.role !== "viewer")
                  this.sendUpdate(this.shared.encode(decode(p.vector)));
                this.emit();
                resolve();
              };
              if (this.deferRemote()) this.welcomeTask = accept;
              else accept();
            } else if (p.type === "update") {
              if (this.deferRemote()) {
                if (
                  this.deferred.reduce((s, v) => s + v.update.length, 0) +
                    p.update.length >
                  90_000_000
                )
                  throw new Error(
                    "Слишком много отложенных изменений. Завершите жест и подключитесь снова.",
                  );
                this.deferred.push(p);
              } else {
                this.shared.apply(decode(p.update));
                this.version = p.version;
              }
              this.emit();
            } else if (p.type === "ack") {
              this.pending.delete(p.seq);
              this.version = Math.max(this.version, p.version);
              this.emit();
            } else if (p.type === "peer" || p.type === "presence") {
              this.peers.set(p.id, p);
              this.emit();
            } else if (p.type === "left") {
              this.peers.delete(p.id);
              this.emit();
            } else if (p.type === "error") {
              this.error = p.error;
              this.status = "error";
              this.emit();
            }
          } catch (error) {
            this.error = String(error);
            this.status = "error";
            socket.close(4002);
            this.emit();
            reject(error);
          }
        };
        socket.onerror = () => {
          if (this.socket !== socket) return;
          if (!welcomed) {
            clearTimeout(timeout);
            reject(new Error("Не удалось соединиться с сервисом."));
          }
        };
        socket.onclose = (e) => {
          if (this.socket !== socket) return;
          clearTimeout(timeout);
          this.ready = false;
          this.welcomeTask = null;
          this.peers.clear();
          if (this.stopped) return;
          if (e.code === 4003) {
            this.status = "revoked";
            this.error =
              "Доступ отозван или сеанс завершён. Локальная копия сохранена.";
          } else if (e.code === 4002) {
            this.status = "error";
            this.error ||=
              "Сервер отклонил изменения. Сохраните отдельную копию.";
          } else {
            this.status = "offline";
            this.scheduleReconnect();
          }
          this.emit();
          if (!welcomed)
            reject(new Error(this.error || "Соединение прервано."));
        };
      });
    } catch (error) {
      if (error instanceof ServiceError && [401, 403].includes(error.status)) {
        this.status = "revoked";
        this.error = error.message;
      }
      if (!["revoked", "error"].includes(this.status)) {
        this.status = "offline";
        this.error = String(error);
        this.scheduleReconnect();
      }
      this.emit();
      throw error;
    }
  }
  private scheduleReconnect() {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.connect().catch(() => {});
      },
      Math.min(30000, 500 * 2 ** Math.min(this.retry++, 6)),
    );
  }
  private sendUpdate(update: Uint8Array) {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.ready) return;
    const data = encode(update);
    if (this.socket.bufferedAmount + data.length > 64 * 1024 * 1024) {
      this.ready = false;
      this.status = "offline";
      this.error = "Соединение перегружено. Изменения остаются на устройстве.";
      this.socket.close(4008);
      this.scheduleReconnect();
      this.emit();
      return;
    }
    const seq = ++this.seq;
    this.pending.add(seq);
    this.socket.send(JSON.stringify({ type: "update", seq, update: data }));
    this.emit();
  }
  flushRemote() {
    if (this.deferRemote()) return;
    const welcome = this.welcomeTask;
    this.welcomeTask = null;
    welcome?.();
    if (!this.deferred.length) return;
    const packets = this.deferred.splice(0);
    for (const p of packets) {
      this.shared.apply(decode(p.update));
      this.version = Math.max(this.version, p.version);
    }
  }
  presence(cursor: Vec | null, selected: string[]) {
    if (this.socket?.readyState === WebSocket.OPEN && this.ready)
      this.socket.send(JSON.stringify({ type: "presence", cursor, selected }));
  }
  async flushCache() {
    if (!this.loaded) return;
    if (this.writingCache) return this.writingCache;
    this.writingCache = (async () => {
      while (this.pendingCache.length) {
        const batch = this.pendingCache.splice(0);
        try {
          if (this.cache.append) await this.cache.append(this.key, batch);
          else await this.cache.save(this.key, this.shared.encode());
        } catch (error) {
          this.pendingCache = [...batch, ...this.pendingCache];
          throw error;
        }
      }
    })().finally(() => {
      this.writingCache = null;
    });
    return this.writingCache;
  }
  close() {
    return (this.closing ??= (async () => {
      this.stopped = true;
      this.ready = false;
      if (this.timer) clearTimeout(this.timer);
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.socket?.close();
      this.status = "offline";
      this.emit();
      try {
        await this.flushCache();
      } finally {
        this.listeners.clear();
      }
    })());
  }
  snapshot() {
    return this.shared.snapshot();
  }
}
export async function createRoom(
  server: string,
  document: BoardDocument,
  token = "",
) {
  return api<{ id: string; token: string; role: Role }>(
    server,
    "/v1/rooms",
    "POST",
    token,
    { document },
  );
}
