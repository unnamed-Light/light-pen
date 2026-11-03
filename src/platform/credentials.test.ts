import { test, expect } from "vitest";
import { CredentialStore, validateCredentials } from "./credentials";
import type { Credentials, SavedRoom } from "./credentials";
const empty = (): Credentials => ({ version: 1, accounts: [], rooms: [] });
const room = (last: string): SavedRoom => ({
  server: "https://boards.example.org",
  room: `12345678-1234-1234-1234-123456789ab${last}`,
  token: "a".repeat(43),
  title: "Доска",
  role: "owner",
  accessedAt: 100,
});
test("serialized credential writes preserve earlier access and recover failed persistence before closing", async () => {
  let stored = empty(),
    fail = true;
  const store = new CredentialStore({
    async load() {
      return empty();
    },
    async save(value) {
      if (fail) {
        fail = false;
        throw new Error("Unavailable");
      }
      stored = structuredClone(value);
    },
  });
  await expect(store.rememberRoom(room("0"))).rejects.toThrow("Unavailable");
  await store.rememberRoom(room("1"));
  await store.flush();
  expect(stored.rooms.map((r) => r.room)).toEqual([
    room("0").room,
    room("1").room,
  ]);
  await Promise.all([
    store.rememberAccount({
      server: room("0").server,
      token: "b".repeat(43),
      login: "alice",
      name: "Алиса",
    }),
    store.forgetRoom(room("0").server, room("0").room),
  ]);
  expect((await store.read()).rooms).toHaveLength(1);
  expect(stored.accounts[0].login).toBe("alice");
});
test("a failed vault read cannot be replaced by an empty or partial set of capabilities", async () => {
  let saves = 0;
  const store = new CredentialStore({
    async load() {
      throw new Error("Cannot decrypt");
    },
    async save() {
      saves++;
    },
  });
  await expect(store.read()).rejects.toThrow("Cannot decrypt");
  await expect(store.rememberRoom(room("0"))).rejects.toThrow("Cannot decrypt");
  await expect(store.flush()).resolves.toBeUndefined();
  expect(saves).toBe(0);
});
test("saved capabilities are scoped to canonical secure endpoints and validated identities", () => {
  expect(
    validateCredentials({ ...empty(), rooms: [room("a")] }).rooms,
  ).toHaveLength(1);
  expect(() =>
    validateCredentials({
      ...empty(),
      rooms: [{ ...room("0"), server: "http://example.org" }],
    }),
  ).toThrow();
  expect(() =>
    validateCredentials({ ...empty(), rooms: [room("0"), room("0")] }),
  ).toThrow();
  expect(() =>
    validateCredentials({
      ...empty(),
      rooms: [{ ...room("0"), token: "short" }],
    }),
  ).toThrow();
});
test("refreshing an account updates only its own saved room credentials; logout preserves independent guest invitations", async () => {
  let value = empty();
  const store = new CredentialStore({
    async load() {
      return empty();
    },
    async save(v) {
      value = structuredClone(v);
    },
  });
  const account = {
    server: room("0").server,
    token: "a".repeat(43),
    login: "alice",
    name: "Alice",
  };
  await store.rememberAccount(account);
  await store.rememberRoom(room("0"));
  await store.rememberRoom({ ...room("1"), token: "g".repeat(43) });
  await store.rememberAccount({ ...account, token: "b".repeat(43) });
  expect(value.rooms.find((r) => r.room === room("0").room)!.token).toBe(
    "b".repeat(43),
  );
  expect(value.rooms.find((r) => r.room === room("1").room)!.token).toBe(
    "g".repeat(43),
  );
  await store.forgetAccount(account.server);
  expect(value.accounts).toEqual([]);
  expect(value.rooms.map((r) => r.room)).toEqual([room("1").room]);
});
