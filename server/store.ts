import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  createHash,
  scrypt as derive,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
const scrypt = promisify(derive);
export const secret = () => randomBytes(32).toString("base64url");
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export async function passwordHash(password: string) {
  if (password.length < 12 || password.length > 256)
    throw new Error("Пароль: от 12 до 256 символов.");
  const salt = randomBytes(16).toString("hex");
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return salt + ":" + key.toString("hex");
}
export async function passwordMatches(password: string, encoded: string) {
  if (password.length > 256) return false;
  const [salt, hex] = encoded.split(":");
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(hex, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export type Role = "owner" | "editor" | "viewer";
export interface Access {
  room: string;
  role: Role;
  principal: string;
  grant: string;
  name: string;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,login TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY,owner TEXT REFERENCES users(id),title TEXT NOT NULL,state BLOB NOT NULL,version INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS grants(hash TEXT PRIMARY KEY,room TEXT NOT NULL REFERENCES rooms(id),role TEXT NOT NULL,expires INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,label TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS grants_room ON grants(room);
      CREATE TABLE IF NOT EXISTS members(room TEXT NOT NULL REFERENCES rooms(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,PRIMARY KEY(room,user_id));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,room TEXT,event TEXT NOT NULL,principal TEXT NOT NULL,time INTEGER NOT NULL);`);
  }
  user(token: string) {
    return this.db
      .prepare(
        "SELECT u.id,u.login,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires>?",
      )
      .get(digest(token), Date.now()) as
      { id: string; login: string; name: string } | undefined;
  }
  session(user: string) {
    const token = secret();
    this.db
      .prepare("INSERT INTO sessions VALUES(?,?,?)")
      .run(digest(token), user, Date.now() + 7 * 86400_000);
    return token;
  }
  access(room: string, token: string): Access | null {
    const user = this.user(token),
      row = this.db.prepare("SELECT owner FROM rooms WHERE id=?").get(room);
    if (!row) return null;
    if (user) {
      if (row.owner === user.id)
        return {
          room,
          role: "owner",
          principal: user.id,
          grant: "account",
          name: user.name,
        };
      const member = this.db
        .prepare("SELECT role FROM members WHERE room=? AND user_id=?")
        .get(room, user.id);
      if (member)
        return {
          room,
          role: member.role as Role,
          principal: user.id,
          grant: "account",
          name: user.name,
        };
    }
    const hash = digest(token),
      grant = this.db
        .prepare(
          "SELECT role,label FROM grants WHERE hash=? AND room=? AND revoked=0 AND expires>?",
        )
        .get(hash, room, Date.now());
    return grant
      ? {
          room,
          role: grant.role as Role,
          principal: hash,
          grant: hash,
          name: grant.label as string,
        }
      : null;
  }
  grant(room: string, role: Role, label: string, hours: number) {
    const token = secret(),
      hash = digest(token);
    this.db
      .prepare("INSERT INTO grants VALUES(?,?,?,?,0,?)")
      .run(hash, room, role, Date.now() + hours * 3600_000, label);
    return { token, id: hash };
  }
  log(room: string, event: string, principal: string) {
    this.db
      .prepare("INSERT INTO audit(room,event,principal,time) VALUES(?,?,?,?)")
      .run(room, event, principal, Date.now());
  }
  close() {
    this.db.close();
  }
}
