import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9225");
const pages = browser.contexts().flatMap((c) => c.pages());
const page = pages.find((p) => p.url().includes("tauri.localhost"));
if (!page) throw new Error("The release WebView was not found.");
await page.locator('[data-ready="true"]').waitFor();
const root = path.resolve("reports");
await mkdir(root, { recursive: true });
const rpc = (command, args = {}) =>
  page.evaluate(
    ({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args),
    { command, args },
  );

if (
  process.argv[2] === "backup-current" ||
  process.argv[2] === "backup-current-v2"
) {
  const session = await rpc("restore_session");
  if (!session.document) throw new Error("No current board");
  const target = path.resolve(
    "boards",
    process.argv[2] === "backup-current-v2"
      ? "Перед обновлением до 0.2.lightpen"
      : "Пробная доска 2026-11-02.lightpen",
  );
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(
    path.join(
      process.env.APPDATA,
      "app.lightpen.desktop",
      "drafts",
      `${session.document.id}.lightpen`,
    ),
    target,
    constants.COPYFILE_EXCL,
  );
  console.log(
    JSON.stringify({
      backup: target,
      title: session.document.title,
      objects: session.document.elements.length,
    }),
  );
} else if (process.argv[2] === "demo") {
  const original = await rpc("restore_session"),
    now = new Date().toISOString();
  const element = (
    id,
    kind,
    x,
    y,
    width,
    height,
    text = "",
    fill = "transparent",
    fontSize = 24,
  ) => ({
    id,
    kind,
    x,
    y,
    width,
    height,
    text,
    fill,
    fontSize,
    color: "#242424",
    strokeWidth: 2,
    opacity: 1,
    createdAt: Date.now(),
  });
  const source = String.raw`x=\frac{-b\pm\sqrt{b^2-4ac}}{2a}`;
  const { renderFormula } = await import("../src/editor/render/math.ts");
  const formula = renderFormula(source, "#0f6cbd", 36);
  const document = {
    schemaVersion: 2,
    id: "light-pen-v2-demo",
    title: "Новые возможности Light Pen",
    revision: 0,
    createdAt: now,
    updatedAt: now,
    elements: [
      {
        ...element(
          "frame",
          "frame",
          0,
          0,
          1050,
          710,
          "Light Pen 0.2",
          "transparent",
          20,
        ),
        color: "#8a8a8a",
      },
      {
        ...element(
          "title",
          "text",
          55,
          65,
          950,
          60,
          "Идеям есть где развернуться",
          "transparent",
          36,
        ),
        bold: true,
      },
      element(
        "intro",
        "text",
        55,
        135,
        950,
        40,
        "Текст, связанные схемы и формулы — на одной локальной доске.",
        "transparent",
        20,
      ),
      {
        ...element(
          "note-a",
          "sticky",
          55,
          220,
          250,
          180,
          "Размер текста\nпод вашу мысль",
          "#fff1a8",
          26,
        ),
        groupId: "demo-group",
      },
      {
        ...element(
          "note-b",
          "sticky",
          450,
          220,
          250,
          180,
          "Соединитель\nследует за объектом",
          "#cfe9fd",
          24,
        ),
        groupId: "demo-group",
      },
      {
        ...element(
          "note-c",
          "sticky",
          825,
          220,
          190,
          180,
          "Закреплённая\nзаметка",
          "#dcd5fa",
          24,
        ),
        locked: true,
      },
      {
        ...element(
          "connection",
          "arrow",
          306,
          310,
          143,
          0,
          "",
          "transparent",
          24,
        ),
        endX: 143,
        endY: 0,
        color: "#0f6cbd",
        groupId: "demo-group",
        startBinding: { elementId: "note-a", side: "right" },
        endBinding: { elementId: "note-b", side: "left" },
      },
      element(
        "math-label",
        "text",
        55,
        455,
        950,
        32,
        "Формулы LaTeX остаются редактируемыми",
        "transparent",
        24,
      ),
      {
        ...element(
          "formula",
          "math",
          80,
          520,
          formula.width,
          formula.height,
          source,
          "transparent",
          36,
        ),
        color: "#0f6cbd",
      },
      element(
        "shortcuts",
        "text",
        55,
        655,
        950,
        28,
        "Ctrl+F — поиск    Ctrl+G — группа    Q — формула    F — фрейм",
        "transparent",
        16,
      ),
    ],
  };
  const target = path.resolve("boards", "Новые возможности Light Pen.lightpen");
  try {
    await rpc("persist_document", { document, path: target });
    console.log(
      JSON.stringify({ demo: target, objects: document.elements.length }),
    );
  } finally {
    if (original.document) {
      const fresh = await rpc("open_recent_document", {
        id: original.document.id,
      });
      await rpc("persist_document", {
        document: fresh.document,
        path: fresh.path,
      });
    }
  }
} else if (process.argv[2] === "inspect") {
  const recovered = await rpc("restore_session");
  const last = recovered.document?.elements.at(-1);
  console.log(
    JSON.stringify(
      {
        url: page.url(),
        title: await page
          .getByRole("textbox", { name: "Название доски" })
          .inputValue(),
        status: await page.getByTestId("save-status").textContent(),
        objects: await page.locator(".board-meta").textContent(),
        savedDocument: {
          id: recovered.document?.id,
          path: recovered.path,
          lastKind: last?.kind,
          lastWidth: last?.width,
          lastHeight: last?.height,
          lastText: last?.text,
        },
        secureContext: await page.evaluate(() => isSecureContext),
        coalescedEvents: await page.evaluate(
          () => "getCoalescedEvents" in PointerEvent.prototype,
        ),
        visibility: await page.evaluate(() => ({
          state: document.visibilityState,
          focused: document.hasFocus(),
        })),
        testHookPresent: await page.evaluate(
          () => "__LIGHT_PEN_TEST__" in window,
        ),
      },
      null,
      2,
    ),
  );
  await page.screenshot({ path: path.join(root, "native-window-content.png") });
} else if (process.argv[2] === "backend") {
  const original = await rpc("restore_session");
  const testId = `native-qa-${Date.now()}`;
  const now = new Date().toISOString();
  const fixture = {
    schemaVersion: 2,
    id: testId,
    title: "Нативная проверка 日本語 ✨",
    revision: 1,
    createdAt: now,
    updatedAt: now,
    elements: Array.from({ length: 10_000 }, (_, i) => ({
      id: `native-shape-${i}`,
      kind: "rectangle",
      x: (i % 100) * 150.25,
      y: Math.floor(i / 100) * 100.125,
      width: 110.5,
      height: 65.25,
      color: "#0f6cbd",
      fill: "#cfe9fd",
      strokeWidth: 2.5,
      opacity: 1,
      createdAt: Date.now(),
    })),
  };
  fixture.elements.push({
    id: "native-long-stroke",
    kind: "stroke",
    x: -100.125,
    y: 35.75,
    width: 1000,
    height: 200,
    color: "#0f6cbd",
    fill: "transparent",
    strokeWidth: 6,
    opacity: 1,
    createdAt: Date.now(),
    points: Array.from({ length: 10_000 }, (_, i) => [
      i * 0.1,
      Math.sin(i * 0.03) * 100,
      i / 10_000,
      i,
    ]),
    ink: { smoothing: 80, stabilization: 55, minWidth: 20, pressure: 125 },
  });
  fixture.elements[0].groupId = "native-test-group";
  fixture.elements[1].groupId = "native-test-group";
  fixture.elements[2].locked = true;
  fixture.elements.push({
    ...fixture.elements[0],
    id: "native-text",
    kind: "text",
    text: "Форматирование 日本語",
    fontSize: 47,
    bold: true,
    italic: true,
    textAlign: "center",
  });
  fixture.elements.push({
    ...fixture.elements[0],
    id: "native-formula",
    kind: "math",
    text: String.raw`\frac{-b\pm\sqrt{b^2-4ac}}{2a}`,
    fontSize: 32,
  });
  fixture.elements.push({
    ...fixture.elements[0],
    id: "native-frame",
    kind: "frame",
    text: "Фрейм",
    fontSize: 20,
    width: 1000,
    height: 600,
  });
  fixture.elements.push({
    ...fixture.elements[0],
    id: "native-connector",
    kind: "arrow",
    endX: 150,
    endY: 0,
    startBinding: { elementId: "native-shape-0", side: "right" },
    endBinding: { elementId: "native-shape-1", side: "left" },
  });
  const target = path.join(root, "Нативная доска v2 日本語.lightpen");
  const report = {};
  try {
    let start = performance.now();
    await rpc("persist_document", { document: fixture, path: target });
    report.saveIpcMs = performance.now() - start;
    start = performance.now();
    const loaded = await rpc("open_document", { path: target });
    report.openIpcMs = performance.now() - start;
    assert.deepStrictEqual(loaded, fixture);
    await rpc("create_checkpoint", { document: fixture });
    const snapshots = await rpc("list_versions", { id: testId });
    assert.equal(snapshots.length, 1);
    assert.deepStrictEqual(
      await rpc("read_version", { id: testId, version: snapshots[0].id }),
      fixture,
    );
    await assert.rejects(() =>
      rpc("read_version", { id: testId, version: "../../session.json" }),
    );
    const bytes = await readFile(target);
    assert.equal(bytes.subarray(0, 16).toString(), "SQLite format 3\0");
    report.fileBytes = bytes.length;
    const recent = await rpc("list_recent_documents");
    assert(recent.some((d) => d.id === testId));
    assert.deepStrictEqual(
      (await rpc("open_recent_document", { id: testId })).document,
      fixture,
    );
    const corrupt = path.join(root, "Повреждённая доска.lightpen");
    await writeFile(corrupt, "invalid board");
    await assert.rejects(() => rpc("open_document", { path: corrupt }));
    const newer = {
      ...fixture,
      revision: 2,
      title: "Recovered despite unavailable folder",
    };
    await assert.rejects(() =>
      rpc("persist_document", {
        document: newer,
        path: path.join(root, "nonexistent-folder", "board.lightpen"),
      }),
    );
    const recovery = await rpc("restore_session");
    assert.deepStrictEqual(recovery.document, newer);
    assert.equal(recovery.needsSave, true);
    const png = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 30;
      c.height = 20;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#0f6cbd";
      ctx.fillRect(0, 0, 30, 20);
      return c.toDataURL("image/png");
    });
    const pngPath = path.join(root, "native-api-export.png");
    await rpc("export_png", { path: pngPath, dataUrl: png });
    assert.equal(
      (await readFile(pngPath)).subarray(0, 8).toString("hex"),
      "89504e470d0a1a0a",
    );
    report.checks = [
      "release IPC round trip",
      "10000 objects + 10000 pressure samples",
      "Unicode path",
      "SQLite signature",
      "recent boards",
      "corrupt file rejected",
      "newest draft recovered after target failure",
      "native PNG write",
      "schema 2 formatting, groups, locks, frames, formula source and ink options",
      "manual version checkpoint through release IPC",
      "exact historical version read",
      "version path traversal rejected",
    ];
    report.testId = testId;
    report.passed = true;
    console.log(JSON.stringify(report, null, 2));
    await writeFile(
      path.join(root, "native-v2-api-report.json"),
      JSON.stringify(report, null, 2),
    );
  } finally {
    if (original.document) {
      const fresh = await rpc("open_recent_document", {
        id: original.document.id,
      });
      await rpc("persist_document", {
        document: fresh.document,
        path: fresh.path,
      });
    }
  }
} else if (process.argv[2] === "close") {
  // This QA command only closes a window whose edits have already been saved.
  assert.equal(
    await page.getByTestId("save-status").textContent(),
    "Сохранено",
  );
  await rpc("plugin:window|destroy", { label: "main" }).catch((error) => {
    if (!String(error).includes("closed")) throw error;
  });
} else if (process.argv[2] === "verify-saved") {
  const file = path.resolve(process.argv[3]);
  const doc = await rpc("open_document", { path: file });
  console.log(
    JSON.stringify(
      {
        title: doc.title,
        elements: doc.elements.length,
        last: doc.elements.at(-1)?.kind,
        pressure: doc.elements.at(-1)?.points?.[0]?.[2],
        documentId: doc.id,
      },
      null,
      2,
    ),
  );
}
await browser.close();
