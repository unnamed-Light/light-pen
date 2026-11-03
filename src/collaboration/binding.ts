import * as Y from "yjs";
import { LOCAL } from "./shared";
import type { Editor } from "../editor/editor";
import type { RoomClient } from "./client";
import { resolveBindings } from "../editor/model/relations";

/** Keeps local gestures atomic; remote packets wait until the active gesture ends. */
export function bindRoom(editor: Editor, client: RoomClient) {
  let applying = false,
    closed = false,
    dirty = false,
    base = client.snapshot();
  editor.setDocument(base);
  editor.readOnly = client.role === "viewer";
  if (editor.readOnly) editor.tool = "select";
  const undo = new Y.UndoManager([client.shared.meta, client.shared.elements], {
    trackedOrigins: new Set([LOCAL]),
    captureTimeout: 0,
  });
  editor.history.external = {
    get canUndo() {
      return undo.undoStack.length > 0;
    },
    get canRedo() {
      return undo.redoStack.length > 0;
    },
    undo: () => {
      if (!editor.readOnly) undo.undo();
    },
    redo: () => {
      if (!editor.readOnly) undo.redo();
    },
  };
  const apply = () => {
    if (!dirty || applying || closed || editor.isInteracting) return;
    dirty = false;
    const next = client.shared.snapshot(editor.document.revision + 1);
    next.elements = resolveBindings(next.elements);
    if (
      next.title === editor.document.title &&
      next.elements.length === editor.elements.length &&
      next.elements.every((e, i) => e === editor.elements[i])
    ) {
      base = editor.document;
      return;
    }
    applying = true;
    editor.document = next;
    editor.pruneGroupScope();
    base = next;
    const ids = new Set(next.elements.map((e) => e.id));
    editor.selected = new Set([...editor.selected].filter((id) => ids.has(id)));
    editor.emit("document");
    editor.emit("scene");
    editor.emit("ui");
    applying = false;
  };
  const onUpdate = (_update: Uint8Array, origin: unknown) => {
    // The just-committed local model already contains this transaction. Avoid
    // materializing and comparing a full CRDT snapshot after every pen gesture.
    if (origin === LOCAL && applying) return;
    dirty = true;
    if (!applying) apply();
  };
  client.shared.doc.on("update", onUpdate);
  const off = editor.subscribe((signal) => {
    if (closed || applying) return;
    if (editor.document.id !== base.id) {
      void close();
      return;
    }
    if (signal === "document") {
      if (editor.readOnly) {
        apply();
        return;
      }
      applying = true;
      try {
        const next = editor.document;
        client.shared.patch(base, next);
        base = next;
      } catch (error) {
        const restored = client.shared.snapshot(editor.document.revision + 1);
        restored.elements = resolveBindings(restored.elements);
        editor.document = restored;
        base = restored;
        editor.pruneGroupScope();
        const ids = new Set(restored.elements.map((e) => e.id));
        editor.selected = new Set(
          [...editor.selected].filter((id) => ids.has(id)),
        );
        editor.emit("document");
        editor.emit("scene");
        editor.emit("ui");
        editor.reportError?.(
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        applying = false;
      }
      apply();
    }
  });
  client.deferRemote = () => editor.isInteracting;
  const beforeClose = () => client.flushCache();
  editor.beforeClose = beforeClose;
  const tick = setInterval(() => {
    client.flushRemote();
    apply();
  }, 40);
  const offClient = client.subscribe(() => {
    const readOnly =
      client.role === "viewer" ||
      client.status === "revoked" ||
      client.status === "error";
    if (editor.readOnly !== readOnly) {
      editor.readOnly = readOnly;
      editor.emit("ui");
    }
  });
  async function close() {
    if (closed) return;
    closed = true;
    clearInterval(tick);
    off();
    offClient();
    client.shared.doc.off("update", onUpdate);
    undo.destroy();
    editor.history.external = null;
    if (editor.beforeClose === beforeClose) editor.beforeClose = null;
    editor.history.clear();
    editor.readOnly = false;
    editor.emit("ui");
    await client.close();
  }
  return { close };
}
