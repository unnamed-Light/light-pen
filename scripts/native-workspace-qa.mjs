import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const assert = (ok, message) => {
  if (!ok) throw Error(message);
};

/** Runs exclusively in the caller's disposable profile, never the default app. */
export async function verifyWorkspace({
  page,
  change,
  tool,
  files,
  profile,
  report,
}) {
  const invoke = (command, args = {}) =>
    page.evaluate(
      ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
      { command, args },
    );
  const original = (await tool("board_read")).context;
  const second = (
    await change("pages", {
      action: "create",
      title: "Нативная вторая страница",
    })
  ).result;
  await change("edit_batch", {
    operations: [
      {
        op: "create",
        elements: [
          {
            id: "page-note",
            kind: "sticky",
            x: 30,
            y: 40,
            width: 200,
            height: 100,
            text: "Страница 日本語 ✓",
          },
          {
            id: "page-frame",
            kind: "frame",
            x: 0,
            y: 0,
            width: 400,
            height: 300,
            text: "Проверка",
          },
        ],
      },
    ],
  });
  const review = await change("frame_review", {
    action: "mark",
    ids: ["page-frame"],
  });
  assert(
    review.result.frames.some((f) => f.id === "page-frame" && f.viewed),
    "Native frame review failed",
  );
  const fragmentPath = join(files, "Фрагмент.lightpen-fragment");
  await change("fragments", {
    action: "export",
    ids: ["page-frame"],
    path: fragmentPath,
    overwrite: true,
  });
  const fragment = JSON.parse(await readFile(fragmentPath, "utf8"));
  assert(fragment.elements.length === 2, "Frame contents were not included");
  const planned = (
    await tool("export_plan", {
      format: "png",
      scope: "page",
      scale: 4,
      padding: 0,
    })
  ).result;
  const pngPath = join(files, "Качество 4x.png");
  await change("export", {
    format: "png",
    scope: "page",
    scale: 4,
    padding: 0,
    path: pngPath,
    overwrite: true,
  });
  const png = await readFile(pngPath);
  const upperPath = join(files, "Native-save.PnG");
  await invoke("export_binary", {
    path: upperPath,
    data: png.toString("base64"),
    format: "png",
  });
  assert(
    (await readFile(upperPath)).equals(png),
    "Native binary writer changed uppercase-extension export",
  );
  assert(
    png.readUInt32BE(16) === planned.width &&
      png.readUInt32BE(20) === planned.height,
    "Native PNG changed requested resolution",
  );
  for (const format of ["zip", "pdf"]) {
    const path = join(files, "Все страницы." + format);
    await change("export", {
      format,
      scope: "workspace",
      path,
      overwrite: true,
    });
    const bytes = await readFile(path);
    assert(bytes.length > 100, "Workspace export empty");
  }
  await change("pages", { action: "switch", id: original.pageId });
  await change("fragments", {
    action: "import",
    path: fragmentPath,
    at: { x: 2000, y: 100 },
  });
  const all = (
    await tool("objects_read", {
      workspace: true,
      includeAssets: false,
      limit: 200,
    })
  ).result;
  assert(
    all.elements.some((e) => e.id === "page-note" && e.pageId === second.id),
    "Inactive page was dropped",
  );
  assert(
    all.elements.filter(
      (e) => e.kind === "sticky" && e.text === "Страница 日本語 ✓",
    ).length === 2,
    "Fragment import did not remap identities",
  );
  const boardPath = join(files, "Страницы и плагины.lightpen");
  await change("document", {
    action: "save_as",
    path: boardPath,
    overwrite: true,
  });
  await change("document", { action: "new" });
  await change("document", { action: "open", path: boardPath });
  assert(
    (await tool("board_read")).result.pageCount === 2,
    "Native save/open lost pages",
  );
  report.checks.push(
    "native_workspace_pages_fragments_review_hq_exports_roundtrip",
  );

  const example = JSON.parse(
    await readFile("plugins/examples/ideas.lightpen-plugin", "utf8"),
  );
  const pluginPath = join(files, "ideas.lightpen-plugin");
  await writeFile(pluginPath, JSON.stringify(example));
  await change("plugins", { action: "install", path: pluginPath });
  let list = (await change("plugins", { action: "list" })).result;
  assert(
    list.find((p) => p.manifest.id === "lightpen.ideas")?.enabled === false,
    "Agent silently enabled plugin",
  );
  // Purpose-built QA uses the native backend in its own disposable profile to
  // simulate the person's grants. Public MCP exposes no activation operation.
  const registry = await invoke("plugin_registry_load");
  const entry = registry.entries.find(
    (e) => e.package.manifest.id === "lightpen.ideas",
  );
  entry.enabled = true;
  entry.grants = { permissions: ["board:read", "board:write"] };
  await invoke("plugin_registry_save", { value: registry });
  await change("document", { action: "save" });
  await page.reload();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="app"]')
        ?.getAttribute("data-ready") === "true",
  );
  await invoke("agent_start", { write: true, folder: files, network: false });
  await change("plugins", {
    action: "invoke",
    command: "lightpen.ideas/counter",
    args: { title: "Нативный виджет", value: 9 },
  });
  const widgets = (
    await tool("objects_read", { workspace: true, limit: 200 })
  ).result.elements.filter((e) => e.widget);
  assert(
    widgets.some((e) => e.widget.fallback === "Нативный виджет\n9"),
    "Production CSP or native plugin Worker failed",
  );
  const ownPluginFrame = await page.locator("iframe").count();
  assert(ownPluginFrame === 0, "Plugin iframe leaked");
  report.checks.push("native_csp_plugin_install_and_mcp_invoke");

  const native = JSON.parse(
    await readFile("plugins/examples/native-stamp.lightpen-plugin", "utf8"),
  );
  const state = await invoke("plugin_registry_load");
  state.entries.push({
    package: native,
    enabled: true,
    grants: { permissions: ["process", "board:write"] },
    data: {},
  });
  await invoke("plugin_registry_save", { value: state });
  let denied = false;
  try {
    await invoke("plugin_process_start", {
      pluginId: native.manifest.id,
      acknowledgeRisk: false,
    });
  } catch (e) {
    denied = String(e).includes("PROCESS_CONFIRMATION_REQUIRED");
  }
  assert(denied, "Native process started without acknowledgment");
  const processId = await invoke("plugin_process_start", {
    pluginId: native.manifest.id,
    acknowledgeRisk: true,
  });
  const read = async (kind) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const messages = await invoke("plugin_process_read", { processId });
      const wanted = messages.find((m) => m.kind === kind);
      if (wanted) return wanted;
      const error = messages.find((m) => m.kind === "error");
      if (error) throw Error(error.error);
      await new Promise((r) => setTimeout(r, 25));
    }
    throw Error("Native extension did not reply");
  };
  try {
    await invoke("plugin_process_send", {
      processId,
      message: {
        kind: "invoke",
        command: "stamp",
        args: { text: "Нативный процесс 日本語 ✓" },
      },
    });
    const call = await read("call");
    assert(
      call.method === "board.apply" &&
        call.args.create[0].text === "Нативный процесс 日本語 ✓",
      "Native Unicode protocol was corrupted",
    );
    await invoke("plugin_process_send", {
      processId,
      message: { kind: "reply", id: call.id, result: { created: ["qa"] } },
    });
    assert(
      (await read("result")).result.created === true,
      "Native process result missing",
    );
  } finally {
    await invoke("plugin_process_stop", { processId });
  }
  report.checks.push(
    "native_process_acknowledgment_job_and_unicode_json_lines",
  );

  const scoped = await invoke("plugin_registry_load");
  const worker = scoped.entries.find(
    (e) => e.package.manifest.id === "lightpen.ideas",
  );
  worker.package.manifest.permissions.push("files:read", "files:write");
  worker.grants = { permissions: ["files:read", "files:write"], folder: files };
  worker.enabled = true;
  await invoke("plugin_registry_save", { value: scoped });
  const allowed = join(files, "plugin-output.txt");
  await invoke("plugin_file", {
    pluginId: "lightpen.ideas",
    action: "write",
    path: allowed,
    data: "Локальный файл ✓",
    overwrite: false,
    agentFolder: files,
  });
  assert(
    (
      await invoke("plugin_file", {
        pluginId: "lightpen.ideas",
        action: "read",
        path: allowed,
        data: null,
        overwrite: false,
        agentFolder: files,
      })
    ).text === "Локальный файл ✓",
    "Native plugin file round trip failed",
  );
  const narrower = join(files, "narrow");
  await mkdir(narrower, { recursive: true });
  let narrowDenied = false;
  try {
    await invoke("plugin_file", {
      pluginId: "lightpen.ideas",
      action: "write",
      path: join(files, "outside-agent-folder.txt"),
      data: "No",
      overwrite: false,
      agentFolder: narrower,
    });
  } catch {
    narrowDenied = true;
  }
  assert(narrowDenied, "Plugin escaped intersection of file grants");
  let privateDenied = false;
  try {
    await invoke("plugin_file", {
      pluginId: "lightpen.ideas",
      action: "write",
      path: join(profile, "private.txt"),
      data: "No",
      overwrite: false,
      agentFolder: files,
    });
  } catch {
    privateDenied = true;
  }
  assert(privateDenied, "Plugin reached private profile");
  report.checks.push("native_plugin_files_intersection_and_private_profile");
  await change("document", { action: "save" });
}
