import { parentPort } from "node:worker_threads";
import { tsImport } from "tsx/esm/api";
const { SharedBoard } = await tsImport(
  "../src/collaboration/shared.ts",
  import.meta.url,
);
const { validateDocument } = await tsImport(
  "../src/editor/model/types.ts",
  import.meta.url,
);
let cached = null;
parentPort.on("message", ({ id, state, update, source, room, maxState }) => {
  const reusable =
    !source &&
    cached?.room === room &&
    Buffer.from(cached.state).equals(Buffer.from(state));
  if (!reusable && cached) {
    cached.board.destroy();
    cached = null;
  }
  const board = reusable ? cached.board : new SharedBoard();
  let kept = false;
  try {
    if (source) {
      let body;
      try {
        body = JSON.parse(Buffer.from(source).toString("utf8"));
      } catch {
        throw new Error("Ожидался JSON.");
      }
      board.seed({ ...validateDocument(body.document), id: room });
    } else {
      if (!reusable) board.apply(state);
      board.apply(update);
    }
    const document = board.snapshot();
    if (board.jsonBytes > 64 * 1024 * 1024)
      throw new Error("Документ превышает ограничение локального файла 64 МБ.");
    if (document.id !== room)
      throw new Error("Нельзя заменить идентификатор комнаты.");
    if (
      [...board.meta.keys()].some(
        (k) => !["id", "title", "createdAt"].includes(k),
      )
    )
      throw new Error("Неизвестные метаданные общей доски.");
    const next = board.encode();
    if (next.length > maxState) throw new Error("Доска слишком большая.");
    // At most one decoded room per bounded worker. A byte match with the durable
    // input state prevents a failed write or rejected candidate poisoning reuse.
    if (next.length <= 8 * 1024 * 1024) {
      cached = { room, board, state: new Uint8Array(next) };
      kept = true;
    } else cached = null;
    parentPort.postMessage({ id, state: next, title: document.title }, [
      next.buffer,
    ]);
  } catch (error) {
    cached = null;
    kept = false;
    parentPort.postMessage({ id, error: String(error.message).slice(0, 300) });
  } finally {
    if (!kept) board.destroy();
  }
});
parentPort.postMessage({ ready: true });
