import { spawn, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createInterface } from "node:readline";
import { chromium } from "@playwright/test";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";
const reservation = createServer();
if (process.platform === "win32")
  for (const name of [
    "light-pen.exe",
    "Light Pen Beta.exe",
    "Light.Pen.Beta.exe",
    "Light Pen Preview.exe",
  ]) {
    const result = execFileSync(
      "tasklist",
      ["/FO", "CSV", "/NH", "/FI", "IMAGENAME eq " + name],
      { encoding: "utf8", windowsHide: true },
    );
    if (result.toLowerCase().includes('"' + name.toLowerCase() + '"'))
      throw Error(
        "Close existing Light Pen before native QA; current work will not be touched.",
      );
  }
await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
const debugPort = reservation.address().port;
await new Promise((r) => reservation.close(r));
const mode = process.argv[2] ?? "debug",
  exe = resolve(
    `src-tauri/target/${mode === "debug" ? "debug" : "release"}/light-pen.exe`,
  ),
  folder = resolve("reports/agent-native-" + mode, Date.now().toString()),
  profile = join(folder, "profile"),
  files = join(folder, "files");
await mkdir(files, { recursive: true });
const env = {
  ...process.env,
  LIGHT_PEN_PROFILE_DIR: profile,
  WEBVIEW2_USER_DATA_FOLDER: join(folder, "webview"),
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + debugPort,
};
const mcp = spawn(exe, ["--mcp", "--profile", profile], {
  env,
  windowsHide: true,
  stdio: ["pipe", "pipe", "pipe"],
});
let sequence = 0,
  stderr = "",
  gui,
  browser;
const pending = new Map();
mcp.stderr.on("data", (b) => (stderr += b.toString()));
createInterface({ input: mcp.stdout }).on("line", (line) => {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw Error("Non-JSON stdout from MCP");
  }
  const p = pending.get(value.id);
  if (p) {
    pending.delete(value.id);
    clearTimeout(p.timer);
    value.error
      ? p.reject(Error(value.error.message))
      : p.resolve(value.result);
  }
});
const rpc = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence,
      timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("MCP timeout: " + method));
      }, 110000);
    pending.set(id, { resolve, reject, timer });
    mcp.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  });
const tool = async (name, args = {}) => {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.isError) throw Error(r.content[0].text);
  return name === "board_preview" ? r : JSON.parse(r.content[0].text);
};
const change = async (name, args = {}, id = randomUUID()) => {
  const { context } = await tool("board_read");
  return tool(name, {
    session: context.session,
    documentId: context.documentId,
    expectedRevision: context.revision,
    requestId: id,
    ...args,
  });
};
const writeContext = async () => {
  const { context: c } = await tool("board_read");
  return {
    session: c.session,
    documentId: c.documentId,
    expectedRevision: c.revision,
    requestId: randomUUID(),
  };
};
const require = (value, message) => {
  if (!value) throw Error(message);
};
const report = { mode, checks: [], files: [] };
try {
  const hello = await rpc("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "Light Pen QA", version: "1" },
  });
  require(hello.serverInfo.version ===
    "0.5.0-beta.1", "Wrong MCP executable version");
  require((await rpc("tools/list")).tools.length === 20, "Catalog unavailable");
  report.checks.push("offline_discovery");
  gui = spawn(exe, [], { env, windowsHide: true, stdio: "ignore" });
  await writeFile(
    join(folder, "gui-process.json"),
    JSON.stringify({ pid: gui.pid, exe, profile }, null, 2),
  );
  for (let n = 0; n < 100; n++) {
    try {
      browser = await chromium.connectOverCDP("http://127.0.0.1:" + debugPort);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!browser) throw Error("Native WebView did not start");
  let page;
  for (let n = 0; n < 100; n++) {
    page = browser
      .contexts()
      .flatMap((c) => c.pages())
      .find(
        (p) =>
          p.url().includes("tauri.localhost") ||
          p.url().includes("127.0.0.1:1420"),
      );
    if (page) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!page) throw Error("Native page unavailable");
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="app"]')
        ?.getAttribute("data-ready") === "true",
  );
  for (let n = 0; n < 40; n++) {
    try {
      await page.evaluate(
        (folder) =>
          window.__TAURI_INTERNALS__.invoke("agent_start", {
            write: true,
            folder,
            network: false,
          }),
        files,
      );
      break;
    } catch (e) {
      if (!String(e).includes("BUSY") || n === 39) throw e;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  await change("document", { action: "new", title: "Нативная проверка ИИ" });
  const elements = [
    {
      kind: "sticky",
      id: "sticky",
      x: 200,
      y: 180,
      width: 260,
      height: 180,
      text: "Доска от агента",
    },
    {
      kind: "math",
      id: "math",
      x: 550,
      y: 180,
      width: 200,
      height: 100,
      text: "\\frac{a}{b}+x^2",
    },
    {
      kind: "table",
      id: "table",
      x: 200,
      y: 420,
      width: 450,
      height: 160,
      cells: [
        ["Товар", "Цена"],
        ["=1+1", "2"],
        ["Бета", "10"],
      ],
      grid: {
        rows: ["h", "a", "b"],
        columns: [
          { id: "name", type: "text" },
          { id: "price", type: "number" },
        ],
      },
    },
    {
      kind: "task",
      id: "task",
      x: 900,
      y: 180,
      width: 260,
      height: 180,
      text: "Проверка ИИ",
      task: {
        status: "doing",
        items: [{ id: "item", text: "Проверено", done: true }],
        due: "2026-11-10",
      },
    },
    {
      kind: "frame",
      id: "frame",
      x: 140,
      y: 120,
      width: 1080,
      height: 560,
      text: "Фрейм ИИ",
    },
  ];
  const before = await tool("board_read"),
    key = randomUUID(),
    args = {
      session: before.context.session,
      documentId: before.context.documentId,
      expectedRevision: before.context.revision,
      requestId: key,
      operations: [{ op: "create", elements }],
    };
  await tool("edit_batch", args);
  await tool("edit_batch", args);
  require((await tool("board_read")).result.objects ===
    5, "Duplicate after retry");
  report.checks.push("native_batch_and_idempotency");
  const stale = await rpc("tools/call", {
    name: "edit_batch",
    arguments: { ...args, requestId: randomUUID() },
  });
  require(stale.isError &&
    stale.content[0].text.includes(
      "REVISION_CONFLICT",
    ), "Stale command accepted");
  const preview = await tool("board_preview", {
    scope: "frame",
    frameId: "frame",
    maxSize: 1000,
  });
  require(preview.content[0].type === "image", "No PNG from MCP");
  const png = Buffer.from(preview.content[0].data, "base64");
  require(png.subarray(1, 4).toString() === "PNG", "Invalid PNG");
  await writeFile(join(folder, "mcp-preview.png"), png);
  report.checks.push("native_png_and_latex");
  await change("document", {
    action: "save_as",
    path: join(files, "Доска 日本語.lightpen"),
    overwrite: true,
  });
  for (const format of ["png", "svg", "pdf", "csv", "tsv"]) {
    const path = join(files, "export." + format);
    await change("export", {
      format,
      path,
      scope: format === "pdf" ? "slides" : "board",
      tableId: ["csv", "tsv"].includes(format) ? "table" : undefined,
      overwrite: true,
    });
    const bytes = await readFile(path);
    require(bytes.length > 20, "Empty " + format);
    report.files.push({
      format,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  require((await readFile(join(files, "export.csv"), "utf8")).includes(
    "'=1+1",
  ), "Unsafe CSV");
  report.checks.push("native_all_exports");
  await change("selection", { action: "set", ids: ["sticky", "math"] });
  const template = (
    await change("templates", { action: "save", title: "Шаблон ИИ" })
  ).result;
  await change("templates", {
    action: "export",
    id: template.id,
    path: join(files, "template.lightpen-template"),
    overwrite: true,
  });
  await change("templates", { action: "remove", id: template.id });
  const imported = (
    await change("templates", {
      action: "import",
      path: join(files, "template.lightpen-template"),
    })
  ).result;
  await change("templates", { action: "insert", id: imported.id });
  await change("templates", { action: "remove", id: imported.id });
  report.checks.push("native_templates");
  await change("image_import", { path: join(files, "export.png") });
  report.checks.push("native_image_import");
  await change("versions", { action: "create" });
  const snapshots = (await change("versions", { action: "list" })).result;
  const old = (await tool("objects_read", { ids: ["sticky"] })).result
    .elements[0].text;
  await change("edit_batch", {
    operations: [{ op: "update", id: "sticky", patch: { text: "изменение" } }],
  });
  await change("versions", { action: "restore", version: snapshots[0].id });
  require((await tool("objects_read", { ids: ["sticky"] })).result.elements[0]
    .text === old, "Version restore failed");
  report.checks.push("native_versions");
  const outside = await rpc("tools/call", {
    name: "export",
    arguments: {
      ...(await writeContext()),
      format: "png",
      path: resolve("reports/forbidden-agent-export.png"),
    },
  });
  require(outside.isError &&
    outside.content[0].text.includes(
      "FILE_PERMISSION_REQUIRED",
    ), "Export outside root guard failed");
  const exists = await rpc("tools/call", {
    name: "document",
    arguments: {
      ...(await writeContext()),
      action: "save_as",
      path: join(files, "Доска 日本語.lightpen"),
    },
  });
  require(exists.isError &&
    exists.content[0].text.includes(
      "FILE_EXISTS",
    ), "Existing output guard failed: " + JSON.stringify(exists));
  report.checks.push("native_folder_and_overwrite_guards");
  await change("document", { action: "save" });
  await change("document", { action: "new", title: "Временная" });
  await change("document", {
    action: "open",
    path: join(files, "Доска 日本語.lightpen"),
  });
  require((await tool("board_read")).result.title ===
    "Нативная проверка ИИ", "File roundtrip failed");
  report.checks.push("native_unicode_file_roundtrip");
  // Fixtures and all files belong to this run's isolated profile.
  const fixtures = await page.evaluate(
    async ({ files, folder }) => {
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const doc = await invoke("open_document", {
        path: files + "/Доска 日本語.lightpen",
      });
      const ids = {};
      for (const [kind, path] of [
        ["inside", files + "/Recent.lightpen"],
        ["outside", folder + "/Private.lightpen"],
        ["unnamed", null],
      ]) {
        const id = crypto.randomUUID();
        ids[kind] = id;
        await invoke("persist_document", {
          document: { ...doc, id, title: kind, revision: 0 },
          path,
        });
      }
      return ids;
    },
    { files, folder },
  );
  const recent = (await change("document", { action: "list_recent" })).result;
  require(recent.some(
    (d) => d.id === fixtures.inside,
  ), "Allowed recent missing");
  require(!recent.some(
    (d) => d.id === fixtures.outside || d.id === fixtures.unnamed,
  ), "Private recent metadata leaked");
  for (const id of [fixtures.outside, fixtures.unnamed]) {
    const denied = await rpc("tools/call", {
      name: "document",
      arguments: { ...(await writeContext()), action: "recent", id },
    });
    require(denied.isError &&
      denied.content[0].text.includes(
        "FILE_PERMISSION_REQUIRED",
      ), "Recent board bypassed folder grant");
  }
  await change("document", { action: "recent", id: fixtures.inside });
  require((await tool("board_read")).context.documentId ===
    fixtures.inside, "Allowed recent failed to open");
  await change("document", {
    action: "open",
    path: join(files, "Доска 日本語.lightpen"),
  });
  report.checks.push("native_recent_scope");
  await change("edit_batch", {
    operations: [{ op: "update", id: "table", patch: { hidden: true } }],
  });
  const hidden = await rpc("tools/call", {
    name: "export",
    arguments: {
      ...(await writeContext()),
      format: "csv",
      path: join(files, "hidden.csv"),
      tableId: "table",
    },
  });
  require(hidden.isError &&
    hidden.content[0].text.includes(
      "Table not found",
    ), "Hidden table exported");
  await change("edit_batch", {
    operations: [{ op: "update", id: "table", patch: { hidden: false } }],
  });
  report.checks.push("native_hidden_table_export");
  require((await tool("board_read")).result.title ===
    "Нативная проверка ИИ", "Recent reopen replaced the source board");
  await change("document", { action: "save" });
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("agent_stop"));
  const revoked = await rpc("tools/call", {
    name: "board_read",
    arguments: {},
  });
  require(revoked.isError, "Revoked session still usable");
  require((await rpc("tools/list")).tools.length ===
    20, "Revocation broke discovery");
  await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("agent_start", {
      write: false,
      folder: null,
      network: false,
    }),
  );
  const readonly = await rpc("tools/call", {
    name: "edit_batch",
    arguments: { ...(await writeContext()), operations: [] },
  });
  require(readonly.isError &&
    readonly.content[0].text.includes("READ_ONLY"), "Read-only grant bypass");
  report.checks.push("native_revocation_and_readonly");
  const readonlyRecent = (await change("document", { action: "list_recent" }))
    .result;
  const readonlyContext = (await tool("board_read")).context;
  require(readonlyRecent.every(
    (d) => d.id === readonlyContext.documentId,
  ), "Read-only recent metadata escaped current board");
  await page.evaluate(() => window.__TAURI_INTERNALS__.invoke("agent_stop"));
  report.folder = folder;
  report.guiPid = gui.pid;
  report.productionTestHook = await page.evaluate(
    () => !!window.__LIGHT_PEN_TEST__,
  );
  if (mode === "release")
    require(!report.productionTestHook, "Test hook in production");
  report.version = hello.serverInfo.version;
  report.passed = true;
  await writeFile(join(folder, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.reject(Error("QA shutting down"));
  }
  pending.clear();
  mcp.stdin.end();
  await browser?.close();
  if (gui) gui.kill();
  setTimeout(() => mcp.kill(), 1000).unref();
  if (stderr.trim())
    console.error("MCP stderr received (" + stderr.length + " characters)");
}
