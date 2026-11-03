import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createCollaborationServer } from "../server/server";
import { RoomClient, createRoom } from "../src/collaboration/client";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
} from "../src/editor/model/types";

const sizes = process.argv.slice(2).length
  ? process.argv.slice(2).map(Number)
  : [1000, 10000];
if (sizes.some((n) => !Number.isInteger(n) || n < 1 || n > 20000))
  throw new Error("Укажите размеры сцены от 1 до 20 000 объектов.");
const root = await mkdtemp(join(tmpdir(), "lightpen-collaboration-benchmark-"));
const server = createCollaborationServer({
  database: join(root, "benchmark.sqlite"),
});
const report: {
  objects: number;
  stateBytes: number;
  createMs: number;
  joinMs: number;
  localPatchP95: number;
  ackP95: number;
  totalUpdateMs: number;
  converged: boolean;
}[] = [];
const clients: RoomClient[] = [];
const cache = {
  async load() {
    return null;
  },
  async save() {},
};
const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
try {
  const url = await server.listen();
  for (const count of sizes) {
    const document = {
      ...createDocument("Нагрузочная доска"),
      elements: Array.from({ length: count }, (_, i) => ({
        ...createElement(
          "rectangle",
          (i % 100) * 180,
          Math.floor(i / 100) * 140,
          DEFAULT_STYLE,
        ),
        width: 140,
        height: 100,
        fill: "#cfe9fd",
      })),
    };
    const created = performance.now();
    const room = await createRoom(url, document);
    const createMs = performance.now() - created;
    const a = new RoomClient(url, room.id, room.token, cache),
      b = new RoomClient(url, room.id, room.token, cache);
    clients.push(a, b);
    const joined = performance.now();
    await a.connect();
    await b.connect();
    const joinMs = performance.now() - joined;
    const patches: number[] = [],
      acks: number[] = [];
    const started = performance.now();
    for (let i = 0; i < 12; i++) {
      const before = a.snapshot(),
        after = {
          ...before,
          elements: before.elements.map((e, j) =>
            j === i ? { ...e, x: e.x + 1 } : e,
          ),
        };
      const start = performance.now();
      a.shared.patch(before, after);
      patches.push(performance.now() - start);
      while (a.unconfirmed) {
        if (a.status === "error" || a.status === "revoked")
          throw new Error("Обновление отклонено сервером: " + a.error);
        if (performance.now() - start > 20000)
          throw new Error("Превышено время подтверждения нагрузочной сцены");
        await new Promise((r) => setTimeout(r, 5));
      }
      acks.push(performance.now() - start);
    }
    const expected = JSON.stringify(a.snapshot().elements);
    const deadline = Date.now() + 5000;
    while (JSON.stringify(b.snapshot().elements) !== expected) {
      if (Date.now() > deadline)
        throw new Error("Клиенты не сошлись после подтверждения");
      await new Promise((r) => setTimeout(r, 10));
    }
    const row = server.store.db
      .prepare("SELECT length(state) bytes FROM rooms WHERE id=?")
      .get(room.id)!;
    report.push({
      objects: count,
      stateBytes: Number(row.bytes),
      createMs,
      joinMs,
      localPatchP95: p95(patches),
      ackP95: p95(acks),
      totalUpdateMs: performance.now() - started,
      converged: true,
    });
    await a.close();
    await b.close();
    console.log(JSON.stringify(report.at(-1)));
  }
  await mkdir("reports", { recursive: true });
  await writeFile(
    "reports/v4-collaboration-load.json",
    JSON.stringify(report, null, 2),
  );
} finally {
  for (const client of clients) await client.close();
  await server.close();
  const target = resolve(root);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !basename(target).startsWith("lightpen-collaboration-benchmark-")
  )
    throw new Error("Неверная временная папка benchmark");
  await rm(target, { recursive: true, force: true });
}
