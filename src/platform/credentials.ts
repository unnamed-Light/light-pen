import { invoke, isTauri } from "@tauri-apps/api/core";
import { serviceUrl } from "../collaboration/client";
import type { Role } from "../collaboration/client";
export interface SavedAccount {
  server: string;
  token: string;
  login: string;
  name: string;
}
export interface SavedRoom {
  server: string;
  room: string;
  token: string;
  title: string;
  role: Role;
  accessedAt: number;
}
export interface Credentials {
  version: 1;
  accounts: SavedAccount[];
  rooms: SavedRoom[];
}
export interface CredentialBackend {
  load(): Promise<Credentials>;
  save(value: Credentials): Promise<void>;
}
const empty = (): Credentials => ({ version: 1, accounts: [], rooms: [] });
export function validateCredentials(value: Credentials) {
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.accounts) ||
    value.accounts.length > 32 ||
    !Array.isArray(value.rooms) ||
    value.rooms.length > 400
  )
    throw new Error("Неподдерживаемое хранилище доступа.");
  const token = (s: string) =>
    typeof s === "string" && /^[a-z\d_-]{43}$/i.test(s);
  const accounts = new Set<string>(),
    rooms = new Set<string>();
  for (const a of value.accounts) {
    if (
      !a ||
      serviceUrl(a.server) !== a.server ||
      !token(a.token) ||
      typeof a.login !== "string" ||
      !a.login ||
      new TextEncoder().encode(a.login).length > 128 ||
      typeof a.name !== "string" ||
      a.name.length > 80 ||
      accounts.has(a.server)
    )
      throw new Error("Повреждён сохранённый аккаунт.");
    accounts.add(a.server);
  }
  for (const r of value.rooms) {
    const key = r?.server + "/" + r?.room;
    if (
      !r ||
      serviceUrl(r.server) !== r.server ||
      !token(r.token) ||
      !/^([a-f\d]{8}-)([a-f\d]{4}-){3}[a-f\d]{12}$/i.test(r.room) ||
      typeof r.title !== "string" ||
      r.title.length > 250 ||
      !["owner", "editor", "viewer"].includes(r.role) ||
      !Number.isSafeInteger(r.accessedAt) ||
      r.accessedAt < 0 ||
      rooms.has(key)
    )
      throw new Error("Повреждён сохранённый доступ к доске.");
    rooms.add(key);
  }
  return value;
}
/** Serial writes retain failed intents in memory for a later flush, never overwrite an unreadable vault. */
export class CredentialStore {
  private initialized: Promise<void> | null = null;
  private current = empty();
  private tail: Promise<void> = Promise.resolve();
  private dirty = false;
  constructor(private backend: CredentialBackend) {}
  private initialize() {
    return (this.initialized ??= this.backend.load().then((value) => {
      this.current = structuredClone(validateCredentials(value));
    }));
  }
  async read() {
    await this.initialize();
    await this.tail.catch(() => {});
    return structuredClone(this.current);
  }
  private mutate(update: (value: Credentials) => Credentials) {
    const work = this.tail
      .catch(() => {})
      .then(async () => {
        await this.initialize();
        const next = validateCredentials(update(structuredClone(this.current)));
        this.current = next;
        this.dirty = true;
        await this.backend.save(structuredClone(next));
        this.dirty = false;
      });
    this.tail = work;
    return work;
  }
  rememberAccount(account: SavedAccount) {
    return this.mutate((v) => {
      const previous = v.accounts.find((a) => a.server === account.server);
      return {
        ...v,
        accounts: [
          ...v.accounts.filter((a) => a.server !== account.server),
          account,
        ],
        rooms: v.rooms.flatMap((room) =>
          room.server === account.server && room.token === previous?.token
            ? previous.login === account.login
              ? [{ ...room, token: account.token }]
              : []
            : [room],
        ),
      };
    });
  }
  forgetAccount(server: string) {
    return this.mutate((v) => {
      const token = v.accounts.find((a) => a.server === server)?.token;
      return {
        ...v,
        accounts: v.accounts.filter((a) => a.server !== server),
        rooms: v.rooms.filter((r) => r.server !== server || r.token !== token),
      };
    });
  }
  rememberRoom(room: SavedRoom) {
    return this.mutate((v) => ({
      ...v,
      rooms: [
        ...v.rooms.filter(
          (r) => r.server !== room.server || r.room !== room.room,
        ),
        room,
      ],
    }));
  }
  forgetRoom(server: string, room: string) {
    return this.mutate((v) => ({
      ...v,
      rooms: v.rooms.filter((r) => r.server !== server || r.room !== room),
    }));
  }
  flush() {
    if (!this.initialized) return Promise.resolve();
    const work = this.tail
      .catch(() => {})
      .then(async () => {
        if (this.dirty) {
          await this.initialize();
          await this.backend.save(structuredClone(this.current));
          this.dirty = false;
        }
      });
    this.tail = work;
    return work;
  }
}
const memoryBackend = (): CredentialBackend => {
  let value = empty();
  return {
    async load() {
      return structuredClone(value);
    },
    async save(next) {
      value = structuredClone(next);
    },
  };
};
export const credentialStore = new CredentialStore(
  isTauri()
    ? {
        load: () => invoke<Credentials>("load_credentials"),
        save: (credentials) => invoke("save_credentials", { credentials }),
      }
    : memoryBackend(),
);
