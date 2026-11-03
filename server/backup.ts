import { DatabaseSync, backup } from "node:sqlite";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

export async function backupDatabase(source: string, target: string) {
  const from = resolve(source),
    to = resolve(target);
  if (from === to) throw new Error("Резервная копия должна иметь другой путь.");
  const file = await open(to, "wx", 0o600);
  await file.close();
  const db = new DatabaseSync(from, { readOnly: true });
  try {
    await backup(db, to);
    const check = new DatabaseSync(to, { readOnly: true });
    try {
      const result = check.prepare("PRAGMA integrity_check").get();
      if (!result || Object.values(result)[0] !== "ok")
        throw new Error("Резервная копия не прошла проверку целостности.");
    } finally {
      check.close();
    }
  } finally {
    db.close();
  }
}
