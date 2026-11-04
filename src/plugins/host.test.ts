import { describe, it, expect } from "vitest";
import { PluginHost } from "./host";
import { parsePackage, jsonValue } from "./validation";
import type {
  HostCall,
  JSONValue,
  Permission,
  PluginBackend,
  PluginPackage,
  PluginRegistry,
} from "./types";
import { Editor } from "../editor/editor";
import { createElement, DEFAULT_STYLE } from "../editor/model/types";

const bundle = (
  permissions: Permission[] = ["board:read", "board:write", "storage"],
): PluginPackage => ({
  manifest: {
    apiVersion: 1,
    id: "test.extension",
    name: "Test extension",
    version: "1.0.0",
    description: "A local test",
    runtime: "worker",
    permissions,
    commands: [{ id: "run", title: "Execute" }],
    widgets: [{ type: "counter", title: "Counter" }],
  },
  code: "LightPen.register({run:()=>null});",
});
async function setup(
  run: (call: HostCall, args: JSONValue) => Promise<JSONValue>,
  permissions: Permission[] = ["board:read", "board:write", "storage"],
) {
  let registry: PluginRegistry = { version: 1, entries: [] };
  const backend: PluginBackend = {
    load: async () => structuredClone(registry),
    save: async (v) => {
      registry = structuredClone(v);
    },
  };
  const editor = new Editor();
  const host = new PluginHost(editor, {
    backend,
    timeoutMs: 120,
    runtimeFactory: () => ({
      invoke: (_c, a, call) => run(call, a),
      stop() {},
    }),
  });
  await host.ready;
  await host.install(bundle(permissions));
  await host.enable("test.extension", {
    permissions,
    ...(permissions.includes("network")
      ? { networkOrigins: ["https://example.com"] }
      : {}),
  });
  return { editor, host, backend, registry: () => registry };
}
describe("plugin transactions and grants", () => {
  it("installs disabled, validates manifests and updates by revoking previous grants", async () => {
    const { host, registry } = await setup(async () => null);
    const updated = bundle();
    updated.manifest.version = "2.0.0";
    await host.update(updated);
    expect(host.list()[0].enabled).toBe(false);
    expect(registry().entries[0].grants.permissions).toEqual([]);
    const invalid = bundle(["process"]);
    expect(() => parsePackage(invalid)).toThrow();
    expect(() => jsonValue({ bad: Infinity })).toThrow();
    expect(() => jsonValue(JSON.parse('{"__proto__":{}}'))).toThrow();
  });
  it("reads a JSON snapshot even when ordinary text has optional undefined properties", async () => {
    const { editor, host } = await setup(async (call) =>
      call("board.read", {}),
    );
    editor.commit(
      [
        {
          ...createElement("sticky", 0, 0, DEFAULT_STYLE),
          width: 200,
          height: 100,
          text: "Привет",
        },
      ],
      "Seed",
    );
    const result = (await host.invoke("test.extension/run")) as any;
    expect(result.elements[0].text).toBe("Привет");
    expect(JSON.stringify(result)).not.toContain("undefined");
  });
  it("pages a large board and omits embedded assets by default, so one large image does not break ordinary plugins", async () => {
    const { editor, host } = await setup(async (call) =>
      call("board.read", { offset: 200, limit: 100 }),
    );
    const shapes = Array.from({ length: 250 }, (_, i) => ({
      ...createElement("rectangle", i * 20, 0, DEFAULT_STYLE),
      id: "shape-" + i,
      width: 10,
      height: 10,
    }));
    editor.commit(
      [
        ...shapes,
        {
          ...createElement("image", 0, 0, DEFAULT_STYLE),
          id: "large-image",
          width: 800,
          height: 600,
          dataUrl: "data:image/png;base64," + "A".repeat(1_200_000),
        },
      ],
      "Large seed",
    );
    const result = (await host.invoke("test.extension/run")) as any;
    expect(result.total).toBe(251);
    expect(result.offset).toBe(200);
    expect(result.elements).toHaveLength(51);
    expect(result.next).toBeNull();
    expect(result.elements[50].dataUrl).toBeUndefined();
    expect(result.elements[50].asset.characters).toBeGreaterThan(1_000_000);
  });
  it("stages several board operations and widget data, then commits one undo on the active page only", async () => {
    const { editor, host } = await setup(async (call) => {
      await call("board.apply", {
        create: [
          {
            id: "one",
            kind: "sticky",
            x: 40,
            y: 40,
            width: 200,
            height: 100,
            text: "Идея",
          },
        ],
      });
      return call("widgets.create", {
        type: "counter",
        data: { count: 3 },
        fallback: "Три идеи",
      });
    });
    editor.commit(
      [
        {
          ...createElement("rectangle", 1, 1, DEFAULT_STYLE),
          id: "inactive",
          width: 50,
          height: 50,
        },
      ],
      "Seed",
    );
    editor.createPage("Вторая");
    editor.history.clear();
    await host.invoke("test.extension/run");
    expect(editor.elements).toHaveLength(2);
    expect(editor.elements[1].widget).toMatchObject({
      data: { count: 3 },
      fallback: "Три идеи",
    });
    expect(editor.document.elements).toHaveLength(3);
    editor.undo();
    expect(editor.elements).toHaveLength(0);
    expect(editor.document.elements[0].id).toBe("inactive");
    expect(editor.history.canUndo).toBe(false);
  });
  it("rolls back the whole command if a later operation fails validation", async () => {
    const { editor, host } = await setup(async (call) => {
      await call("board.apply", {
        create: [{ id: "one", kind: "rectangle", width: 100, height: 100 }],
      });
      return call("board.apply", {
        update: [{ id: "one", patch: { opacity: 4 } }],
      });
    });
    const before = editor.document;
    await expect(host.invoke("test.extension/run")).rejects.toThrow();
    expect(editor.document).toBe(before);
    expect(editor.history.canUndo).toBe(false);
  });
  it("refuses board writes without the plugin grant and blocks a read-only command from writing", async () => {
    const { host, editor } = await setup(
      async (call) => call("board.apply", { create: [{ kind: "rectangle" }] }),
      ["board:read"],
    );
    await expect(host.invoke("test.extension/run")).rejects.toThrow(
      "PLUGIN_PERMISSION_REQUIRED",
    );
    expect(editor.elements).toHaveLength(0);
    const updated = bundle();
    updated.manifest.commands[0].readOnly = true;
    await host.update(updated);
    await host.enable("test.extension", { permissions: ["board:write"] });
    await expect(host.invoke("test.extension/run")).rejects.toThrow(
      "READ_ONLY",
    );
  });
  it("detects a page change during an asynchronous command before touching either page", async () => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    const { editor, host } = await setup(async (call) => {
      entered();
      await new Promise<void>((r) => (release = r));
      return call("board.apply", { create: [{ kind: "rectangle" }] });
    });
    const p = editor.createPage("Другая");
    editor.switchPage("main");
    const pending = host.invoke("test.extension/run");
    await started;
    editor.switchPage(p.id);
    release();
    await expect(pending).rejects.toThrow("REVISION_CONFLICT");
    expect(editor.document.elements).toHaveLength(0);
  });
  it("stops an in-flight write after disabling the plugin and times out a silent runtime", async () => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    const { editor, host } = await setup(async (call) => {
      entered();
      await new Promise<void>((r) => (release = r));
      return call("board.apply", { create: [{ kind: "rectangle" }] });
    });
    const pending = host.invoke("test.extension/run");
    await started;
    await host.disable("test.extension");
    release();
    await expect(pending).rejects.toThrow("PLUGIN_DISABLED");
    expect(editor.elements).toHaveLength(0);
    const idle = await setup(async () => new Promise<JSONValue>(() => {}));
    await expect(idle.host.invoke("test.extension/run")).rejects.toThrow(
      "PLUGIN_TIMEOUT",
    );
  });
  it("intersects agent network/files permissions with plugin permissions and never auto-starts native programs", async () => {
    const { host, editor } = await setup(
      async (call) => call("network.fetch", { url: "https://example.com" }),
      ["network"],
    );
    await host.enable("test.extension", {
      permissions: ["network"],
      networkOrigins: ["https://example.com"],
    });
    const guard = {
      session: "session",
      documentId: editor.document.id,
      expectedRevision: editor.document.revision,
      pageId: "main",
      requestId: "no-network",
      network: false,
      files: false,
      assert() {},
    };
    await expect(host.invoke("test.extension/run", {}, guard)).rejects.toThrow(
      "NETWORK_PERMISSION_REQUIRED",
    );
    const native: PluginPackage = {
      manifest: {
        ...bundle(["process"]).manifest,
        runtime: "process",
        process: { executable: "C:\\example.exe" },
      },
    };
    await host.update(native);
    await host.enable("test.extension", { permissions: ["process"] });
    await expect(host.invoke("test.extension/run")).rejects.toThrow(
      "PROCESS_START_REQUIRED",
    );
  });
  it("applies the current group scope before validation instead of committing then reporting failure", async () => {
    const { host, editor } = await setup(async (call) =>
      call("board.apply", { create: [{ id: "new", kind: "rectangle" }] }),
    );
    editor.commit(
      [
        {
          ...createElement("rectangle", 0, 0, DEFAULT_STYLE),
          id: "existing",
          width: 100,
          height: 100,
          groupId: "g",
          groupPath: ["g"],
        },
      ],
      "Seed",
    );
    editor.groupScope = ["g"];
    await host.invoke("test.extension/run");
    expect(editor.elements.find((x) => x.id === "new")?.groupPath).toEqual([
      "g",
    ]);
  });
  it("revokes agent writes that were validated before a delayed asset finished decoding", async () => {
    let release!: () => void,
      entered!: () => void,
      allowed = true;
    const started = new Promise<void>((r) => (entered = r));
    const { editor, host } = await setup(async (call) =>
      call("board.apply", {
        create: [{ kind: "math", text: "x^2", width: 200, height: 100 }],
      }),
    );
    editor.services.set("validate_assets", async () => {
      entered();
      await new Promise<void>((r) => (release = r));
    });
    const args = {
      session: "s",
      documentId: editor.document.id,
      expectedRevision: 0,
      pageId: "main",
      requestId: "revoke",
      assert() {
        if (!allowed) throw Error("ACCESS_REVOKED");
      },
    };
    const pending = host.invoke("test.extension/run", {}, args);
    await started;
    allowed = false;
    release();
    await expect(pending).rejects.toThrow("ACCESS_REVOKED");
    expect(editor.elements).toHaveLength(0);
  });
});
