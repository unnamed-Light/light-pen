import { describe, it, expect } from "vitest";
import { AgentController } from "./controller";
import { elementFields } from "./catalog";
import { Editor } from "../editor/editor";
import { createElement, DEFAULT_STYLE } from "../editor/model/types";
import { RoomClient } from "../collaboration/client";
import { bindRoom } from "../collaboration/binding";
import { createCollaborationServer } from "../../server/server";
import { createRoom } from "../collaboration/client";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
function setup() {
  const e = new Editor(),
    a = new AgentController(e);
  a.enable({
    session: "test-session",
    write: true,
    files: false,
    network: false,
  });
  return { e, a };
}
const element = (id: string, kind = "sticky") =>
  JSON.parse(
    JSON.stringify({
      ...createElement(kind as any, 0, 0, DEFAULT_STYLE),
      id,
      width: 200,
      height: 150,
      text: "Текст",
    }),
  );
const context = (a: AgentController) => ({
  session: a.grant!.session,
  requestId: crypto.randomUUID(),
  documentId: a.editor.document.id,
  expectedRevision: a.editor.document.revision,
});
const edit = (a: AgentController, operations: unknown[]) =>
  a.call("edit_batch", { ...context(a), operations });
describe("Agent command contract", () => {
  it("bounds receipt memory, keeps retries working at quota and never retains read-only snapshots", async () => {
    const e = new Editor();
    const service = async (name: string) =>
      name === "settings"
        ? { payload: "x".repeat(2048) }
        : { elements: ["read without a cached snapshot"] };
    const a = new AgentController(e, service, 1024);
    a.enable({ session: "quota", write: true, files: false, network: false });
    const args = context(a),
      result = await a.call("settings", args);
    await expect(a.call("settings", context(a))).rejects.toThrow(
      "SESSION_FULL",
    );
    expect(await a.call("settings", args)).toEqual(result);
    expect(
      await a.call("templates", {
        ...context(a),
        action: "read",
        id: "template",
      }),
    ).toEqual({ elements: ["read without a cached snapshot"] });
    a.enable({
      session: "new-session",
      write: true,
      files: false,
      network: false,
    });
    await expect(a.call("settings", context(a))).resolves.toEqual(result);
  });
  it("new elements use current paint/ink settings and keep those options on later changes", async () => {
    const { a, e } = setup();
    e.style = { ...e.style, color: "#7f52c5", fontSize: 64 };
    e.pen = { ...e.pen, smoothing: 80 };
    await edit(a, [
      {
        op: "create",
        elements: [
          {
            kind: "stroke",
            id: "ink",
            x: 0,
            y: 0,
            width: 20,
            height: 20,
            points: [
              [0, 0, 0.5, 0],
              [20, 20, 0.8, 100],
            ],
          },
          { kind: "sticky", id: "note", x: 0, y: 0, width: 200, height: 120 },
          { kind: "task", id: "task", x: 0, y: 0, width: 200, height: 120 },
        ],
      },
    ]);
    expect(e.elements[0].color).toBe("#7f52c5");
    expect(e.elements[0].ink!.smoothing).toBe(80);
    expect(e.elements[1].fill).toBe("#fff1a8");
    expect(e.elements[1].fontSize).toBe(64);
    expect(e.elements[2].task!.status).toBe("todo");
    e.pen.smoothing = 20;
    expect(e.elements[0].ink!.smoothing).toBe(80);
  });
  it("rejects an asynchronous batch when a user starts a gesture before validation finishes", async () => {
    const { a, e } = setup();
    let release!: () => void;
    e.services.set(
      "validate_assets",
      () => new Promise<void>((r) => (release = r)),
    );
    const pending = edit(a, [
      {
        op: "create",
        elements: [{ ...element("formula", "math"), text: "x" }],
      },
    ]);
    pending.catch(() => {});
    while (!release) await new Promise((r) => setTimeout(r, 1));
    e.editing = { element: element("user"), isNew: true, value: "User input" };
    release();
    await expect(pending).rejects.toThrow("BUSY");
    expect(e.elements).toHaveLength(0);
    expect(e.editing.value).toBe("User input");
  });
  it("imports quoted CSV through the editor parser without changing stable axes unnecessarily", async () => {
    const { a, e } = setup();
    await edit(a, [
      {
        op: "create",
        elements: [
          {
            ...element("table", "table"),
            cells: [
              ["A", "B"],
              ["1", "2"],
            ],
            grid: {
              rows: ["h", "r"],
              columns: [
                { id: "a", type: "text" },
                { id: "b", type: "text" },
              ],
            },
          },
        ],
      },
    ]);
    await edit(a, [
      {
        op: "table",
        id: "table",
        action: "import_csv",
        source: 'A,B\n"line\nbreak","=1+1"',
      },
    ]);
    expect(e.elements[0].cells![1]).toEqual(["line\nbreak", "=1+1"]);
    expect(e.elements[0].grid!.rows).toEqual(["h", "r"]);
    const before = e.document;
    await expect(
      edit(a, [
        {
          op: "table",
          id: "table",
          action: "import_csv",
          source: '"unfinished',
        },
      ]),
    ).rejects.toThrow();
    expect(e.document).toBe(before);
  });
  it("discovers the complete tool set/resources only after explicit enable", async () => {
    const { a } = setup();
    const list = (await a.rpc("tools/list")) as any;
    expect(list.tools).toHaveLength(20);
    expect(new Set(list.tools.map((t: any) => t.name)).size).toBe(
      list.tools.length,
    );
    expect(Object.keys(elementFields)).toContain("task");
    expect(((await a.rpc("resources/list")) as any).resources).toHaveLength(2);
    a.disable();
    await expect(a.rpc("tools/list")).rejects.toThrow("DISABLED");
  });
  it("creates every existing object type and all fields in one undoable operation", async () => {
    const { e, a } = setup();
    const kinds = [
      "rectangle",
      "ellipse",
      "diamond",
      "text",
      "sticky",
      "frame",
      "math",
      "image",
      "table",
      "task",
      "link",
      "line",
      "arrow",
      "stroke",
    ];
    const els = kinds.map((kind, i) => ({
      ...element("e" + i, kind),
      ...(kind === "math" ? { text: "x^2" } : {}),
      ...(kind === "image" ? { dataUrl: "data:image/png;base64,AAAA" } : {}),
      ...(["line", "arrow"].includes(kind) ? { endX: 300, endY: 100 } : {}),
      ...(kind === "stroke"
        ? {
            points: [
              [0, 0, 0.5, 0],
              [10, 10, 1, 100],
            ],
          }
        : {}),
      ...(kind === "table"
        ? {
            cells: [
              ["A", "B"],
              ["1", "2"],
            ],
            grid: {
              rows: ["r0", "r1"],
              columns: [
                { id: "c0", type: "text" },
                { id: "c1", type: "number" },
              ],
            },
          }
        : {}),
      ...(kind === "task"
        ? {
            task: {
              status: "todo",
              items: [{ id: "i1", text: "Пункт", done: false }],
              priority: "high",
              start: "2026-11-03",
              due: "2026-11-04",
              estimate: 2,
              tags: ["Бета"],
              description: "Описание",
            },
          }
        : {}),
      ...(kind === "link" ? { link: { path: "", elementId: "e0" } } : {}),
    }));
    const r = (await edit(a, [
      { op: "create", elements: els },
      { op: "rename", title: "Проект" },
    ])) as any;
    expect(r.created).toHaveLength(14);
    expect(e.document.title).toBe("Проект");
    e.undo();
    expect(e.elements).toHaveLength(0);
    e.redo();
    expect(e.elements).toHaveLength(14);
    expect(e.document.title).toBe("Проект");
  });
  it("rejects the entire transaction on malformed fields, locked indirect changes and unknown operations", async () => {
    const { e, a } = setup();
    await edit(a, [
      {
        op: "create",
        elements: [
          element("a"),
          { ...element("b"), locked: true, groupId: "g" },
          { ...element("c"), groupId: "g" },
        ],
      },
    ]);
    const before = e.document;
    await expect(
      edit(a, [
        { op: "update", id: "a", patch: { text: "new" } },
        { op: "update", id: "a", patch: { fill: "red" } },
      ]),
    ).rejects.toThrow();
    expect(e.document).toBe(before);
    await expect(
      edit(a, [{ op: "transform", ids: ["c"], action: "ungroup" }]),
    ).rejects.toThrow("LOCKED");
    expect(e.document).toBe(before);
    await expect(edit(a, [{ op: "eval", source: "anything" }])).rejects.toThrow(
      "invalid operation",
    );
    expect(e.document).toBe(before);
  });
  it("deduplicates concurrent and later retries and detects reused keys", async () => {
    const { a, e } = setup();
    const args = {
      ...context(a),
      operations: [{ op: "create", elements: [element("a")] }],
    };
    const [x, y] = await Promise.all([
      a.call("edit_batch", args),
      a.call("edit_batch", args),
    ]);
    expect(x).toEqual(y);
    expect(e.elements).toHaveLength(1);
    await a.call("edit_batch", args);
    expect(e.document.revision).toBe(1);
    await expect(
      a.call("edit_batch", { ...args, label: "other" }),
    ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
  });
  it("rejects stale revisions, old sessions, read-only grants, viewers and active gestures", async () => {
    const { a, e } = setup();
    const stale = {
      ...context(a),
      operations: [{ op: "create", elements: [element("a")] }],
    };
    e.rename("Changed");
    await expect(a.call("edit_batch", stale)).rejects.toThrow(
      "REVISION_CONFLICT",
    );
    await expect(
      a.call("edit_batch", { ...stale, session: "old" }),
    ).rejects.toThrow("SESSION_CHANGED");
    a.enable({ ...a.grant!, write: false });
    await expect(
      edit(a, [{ op: "create", elements: [element("a")] }]),
    ).rejects.toThrow("READ_ONLY");
    a.enable({ ...a.grant!, write: true });
    e.readOnly = true;
    await expect(
      edit(a, [{ op: "create", elements: [element("a")] }]),
    ).rejects.toThrow("READ_ONLY");
    e.readOnly = false;
    e.editing = { element: element("draft"), isNew: true, value: "typing" };
    await expect(
      edit(a, [{ op: "create", elements: [element("a")] }]),
    ).rejects.toThrow("BUSY");
  });
  it("checks revocation and revision again after asynchronous asset validation", async () => {
    const { a, e } = setup();
    let release!: () => void;
    e.services.set(
      "validate_assets",
      () => new Promise<void>((r) => (release = r)),
    );
    const pending = edit(a, [
      {
        op: "create",
        elements: [{ ...element("formula", "math"), text: "x" }],
      },
    ]);
    while (!release) await new Promise((r) => setTimeout(r, 1));
    e.rename("User title");
    release();
    await expect(pending).rejects.toThrow("REVISION_CONFLICT");
    expect(e.elements).toHaveLength(0);
  });
  it("supports table identity-preserving structure/cells, typed query and spreadsheet-safe CSV", async () => {
    const { a, e } = setup();
    await edit(a, [
      {
        op: "create",
        elements: [
          {
            ...element("table", "table"),
            cells: [
              ["Name", "Value"],
              ["=1+1", "2"],
              ["B", "10"],
            ],
            grid: {
              rows: ["h", "a", "b"],
              columns: [
                { id: "name", type: "text" },
                { id: "value", type: "number" },
              ],
            },
          },
        ],
      },
    ]);
    await edit(a, [
      { op: "table", id: "table", action: "insert_row", row: 2 },
      {
        op: "table",
        id: "table",
        action: "cell",
        row: 2,
        column: 0,
        value: "C",
      },
      {
        op: "table",
        id: "table",
        action: "cell",
        row: 2,
        column: 1,
        value: "5",
      },
      {
        op: "table",
        id: "table",
        action: "sort",
        query: { sortColumn: 1, sortDirection: "desc" },
      },
    ]);
    const r = (await a.call("table_read", {
      id: "table",
      includeCsv: true,
    })) as any;
    expect(r.records.map((r: any) => r.values[1].value)).toEqual([10, 5, 2]);
    expect(r.csv).toContain("'=1+1");
    expect(r.grid.rows).toContain("a");
    expect(e.elements[0].cells).toHaveLength(4);
  });
  it("preserves connector references and nested groups across transforms, duplicate and undo", async () => {
    const { a, e } = setup();
    await edit(a, [
      {
        op: "create",
        elements: [
          element("a"),
          { ...element("b"), x: 400 },
          {
            ...element("arrow", "arrow"),
            endX: 400,
            endY: 0,
            startBinding: { elementId: "a", side: "right" },
            endBinding: { elementId: "b", side: "left" },
          },
        ],
      },
      { op: "transform", action: "group", ids: ["a", "b", "arrow"] },
      { op: "transform", action: "group", ids: ["a", "b", "arrow"] },
    ]);
    expect(e.elements[0].groupPath).toHaveLength(2);
    await edit(a, [
      { op: "transform", action: "move", ids: ["a", "b"], x: 20, y: 30 },
    ]);
    expect(
      e.elements.find((e) => e.id === "arrow")!.startBinding!.elementId,
    ).toBe("a");
    await edit(a, [
      { op: "transform", action: "duplicate", ids: ["a", "b", "arrow"] },
    ]);
    expect(e.elements).toHaveLength(6);
    const copy = e.elements.filter((e) => !["a", "b", "arrow"].includes(e.id));
    expect(
      copy.find((e) => e.kind === "arrow")!.startBinding!.elementId,
    ).not.toBe("a");
    e.undo();
    expect(e.elements).toHaveLength(3);
  });
  it("paginates assets/points and exposes diagnostics without unbounded overlap scanning", async () => {
    const { a } = setup();
    await edit(a, [
      {
        op: "create",
        elements: [
          element("a"),
          element("b"),
          {
            ...element("ink", "stroke"),
            points: [
              [0, 0, 0.5, 0],
              [1, 1, 0.6, 10],
              [2, 2, 0.7, 20],
            ],
          },
        ],
      },
    ]);
    const r = (await a.call("objects_read", { limit: 1 })) as any;
    expect(r.total).toBe(3);
    expect(r.next).toBe(1);
    const stroke = (await a.call("objects_read", {
      ids: ["ink"],
      includePoints: true,
      pointOffset: 1,
      pointLimit: 1,
    })) as any;
    expect(stroke.elements[0].points).toEqual([[1, 1, 0.6, 10]]);
    expect(((await a.call("board_inspect", {})) as any).overlaps).toHaveLength(
      1,
    );
  });
  it("returns structured MCP errors and does not forward arbitrary commands", async () => {
    const { a } = setup();
    const r = (await a.rpc("tools/call", {
      name: "eval",
      arguments: {},
    })) as any;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Unknown tool");
    await expect(
      a.call("settings", { ...context(a), unexpected: true }),
    ).rejects.toThrow("unknown field");
    await expect(
      a.call("export", {
        ...context(a),
        format: "png",
        path: "C:/outside.png",
      }),
    ).rejects.toThrow("FILE_PERMISSION_REQUIRED");
    await expect(
      a.call("collaboration", {
        ...context(a),
        action: "create",
        server: "https://example.org",
      }),
    ).rejects.toThrow("NETWORK_PERMISSION_REQUIRED");
  });
  it("routes camera, replay, selection, tasks and safe application commands", async () => {
    const { a, e } = setup();
    await edit(a, [
      {
        op: "create",
        elements: [
          { ...element("t", "task"), task: { status: "todo", items: [] } },
        ],
      },
    ]);
    await a.call("camera", {
      action: "set",
      camera: { x: 10, y: 20, zoom: 2 },
    });
    expect(e.camera.zoom).toBe(2);
    await a.call("selection", { ...context(a), action: "set", ids: ["t"] });
    expect([...e.selected]).toEqual(["t"]);
    await a.call("replay", { action: "start" });
    await a.call("replay", { action: "seek", progress: 0.5 });
    expect(e.replay?.progress).toBe(0.5);
    await a.call("replay", { action: "stop" });
    expect(((await a.call("tasks_read", {})) as any).counts.total).toBe(1);
  });
  it("agent batches join the real CRDT history and preserve a remote participant on undo", async () => {
    const folder = await mkdtemp(join(tmpdir(), "lightpen-agent-"));
    const server = createCollaborationServer({
      database: join(folder, "db.sqlite"),
    });
    let c: RoomClient | undefined,
      peer: RoomClient | undefined,
      bind: ReturnType<typeof bindRoom> | undefined;
    try {
      const url = await server.listen(),
        { a, e } = setup(),
        room = await createRoom(url, e.document),
        cache = {
          async load() {
            return null;
          },
          async save() {},
        };
      c = new RoomClient(url, room.id, room.token, cache);
      peer = new RoomClient(url, room.id, room.token, cache);
      await c.connect();
      await peer.connect();
      bind = bindRoom(e, c);
      await edit(a, [{ op: "create", elements: [element("local")] }]);
      await wait(() => !c!.unconfirmed);
      await wait(() => peer!.snapshot().elements.some((e) => e.id === "local"));
      const before = peer.snapshot();
      peer.shared.patch(before, {
        ...before,
        elements: [...before.elements, element("remote")],
      });
      await wait(() => e.elements.some((e) => e.id === "remote"));
      await a.call("history", { ...context(a), action: "undo" });
      await wait(() => !c!.unconfirmed);
      expect(e.elements.map((e) => e.id)).toEqual(["remote"]);
    } finally {
      await bind?.close();
      await c?.close();
      await peer?.close();
      await server.close();
      if (
        dirname(folder) !== tmpdir() ||
        !basename(folder).startsWith("lightpen-agent-")
      )
        throw Error("Unsafe cleanup");
      await rm(folder, { recursive: true, force: true });
    }
  }, 20000);
});
async function wait(fn: () => boolean) {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 10000) throw Error("Timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
