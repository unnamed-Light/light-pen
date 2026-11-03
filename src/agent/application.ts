import { invoke } from "@tauri-apps/api/core";
import type { AgentController } from "./controller";
import { exampleDocument } from "../editor/editor";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
  validateDocument,
} from "../editor/model/types";
import type { BoardDocument } from "../editor/model/types";
import type { BoardRenderer } from "../editor/render/renderer";
import type { SaveCoordinator } from "../platform/persistence";
import {
  checkpoint,
  listTemplates,
  readTemplate,
  readVersion,
  saveTemplate,
  removeTemplate,
  versions,
  native,
} from "../platform/native";
import { toCsv } from "../editor/model/tables";
import { queryTasks } from "../editor/model/tasks";
import { copyElements } from "../editor/model/relations";

export function installApplicationCommands(
  agent: AgentController,
  saver: SaveCoordinator,
  renderer: () => BoardRenderer | null,
  ui: {
    theme: (dark: boolean) => void;
    present: (value: boolean) => void;
    help: () => void;
    export: () => void;
  },
) {
  const e = agent.editor;
  const file = async (
    action: string,
    path: string,
    format: string,
    extra: Record<string, unknown> = {},
  ) => {
    if (!native)
      throw Error(
        "DESKTOP_REQUIRED: file access is available in the desktop app",
      );
    return invoke<any>("agent_file", {
      session: agent.grant?.session,
      action,
      path,
      format,
      overwrite: false,
      data: null,
      document: null,
      ...extra,
    });
  };
  const unchanged = (a: Record<string, any>) => {
    agent.guard(true);
    if (e.isInteracting || !e.enabled)
      throw Error("BUSY: finish current input before switching documents");
    if (
      e.document.id !== a.documentId ||
      e.document.revision !== a.expectedRevision
    )
      throw Error("REVISION_CONFLICT: board changed while waiting");
    if (!agent.grant || agent.grant.session !== a.session)
      throw Error("ACCESS_REVOKED");
  };
  const switchTo = async (
    doc: BoardDocument,
    path: string | null,
    a: Record<string, any>,
  ) => {
    validateDocument(doc);
    await saver.flush();
    unchanged(a);
    e.setDocument(doc);
    saver.reset(path);
    saver.schedule(doc);
    return { id: doc.id, title: doc.title };
  };
  const exportPng = async (a: Record<string, any>) => {
    const r = renderer();
    if (!r) throw Error("Renderer is not ready");
    if (a.scope === "selection" && !e.selected.size)
      throw Error("Selection is empty");
    if (a.scope === "frame" && !e.slides.some((f) => f.id === a.frameId))
      throw Error("Frame not found");
    return r.exportPng(
      a.scope === "selection",
      a.scope === "frame" ? a.frameId : undefined,
      a.maxSize ?? 8192,
    );
  };
  const handlers: Record<string, (a: Record<string, any>) => Promise<unknown>> =
    {
      validate_assets: async (a) => {
        for (const el of a.elements) {
          if (el.kind === "image") {
            const encoded = el.dataUrl.split(",")[1] ?? "";
            if (
              Math.floor((encoded.length * 3) / 4) -
                (encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0) >
              20 * 1024 * 1024
            )
              throw Error("Image exceeds 20 MB");
            const image = new Image();
            image.src = el.dataUrl;
            await image.decode();
            if (
              !image.naturalWidth ||
              !image.naturalHeight ||
              image.naturalWidth * image.naturalHeight > 32_000_000
            )
              throw Error("Invalid image or image exceeds 32 MP");
          } else if (el.kind === "math") {
            const { renderFormula } = await import("../editor/render/math");
            await renderFormula(el.text ?? "", el.color);
          }
        }
        return { valid: true };
      },
      settings: async (a) => {
        for (const key of ["favoriteColors", "recentColors"])
          if (a[key] && a[key].some((c: string) => !/^#[a-f\d]{6}$/i.test(c)))
            throw Error("Palette colors must use #RRGGBB");
        if (a.style) {
          validateDocument({
            ...createDocument(),
            elements: [
              {
                ...createElement("rectangle", 0, 0, DEFAULT_STYLE),
                width: 1,
                height: 1,
                ...a.style,
              },
            ],
          });
        }
        if (a.tool) e.setTool(a.tool);
        if (a.style) e.setStyle(a.style);
        if (a.pen) {
          e.pen = { ...a.pen };
          localStorage.setItem("lightpen.pen", JSON.stringify(e.pen));
        }
        for (const k of ["eraserSize", "markerSize"] as const)
          if (a[k] !== undefined) {
            e[k] = a[k];
            localStorage.setItem("lightpen." + k, String(a[k]));
          }
        if (a.connectorStyle) e.connectorStyle = a.connectorStyle;
        for (const k of ["grid", "snap"] as const)
          if (a[k] !== undefined) e[k] = a[k];
        if (a.dark !== undefined) ui.theme(a.dark);
        if (a.minimap !== undefined)
          await service("minimap", { open: a.minimap });
        for (const key of ["favoriteColors", "recentColors"])
          if (a[key])
            localStorage.setItem(
              key === "recentColors"
                ? "lightpen.colors"
                : "lightpen.favoriteColors",
              JSON.stringify(a[key]),
            );
        if (a.favoriteColors || a.recentColors)
          window.dispatchEvent(new Event("lightpen-palette"));
        e.emit("scene");
        e.emit("ui");
        return { style: e.style, pen: e.pen, tool: e.tool };
      },
      preferences_read: async () => ({
        dark: document.documentElement.dataset.theme === "dark",
        minimap: localStorage.getItem("lightpen.minimap") === "true",
        favoriteColors: palette("lightpen.favoriteColors"),
        recentColors: palette("lightpen.colors"),
      }),
      document: async (a) => {
        switch (a.action) {
          case "new":
            return switchTo(createDocument(a.title), null, a);
          case "example":
            return switchTo(exampleDocument(), null, a);
          case "list_recent":
            return native
              ? invoke("agent_recent", {
                  session: a.session,
                  currentId: e.document.id,
                  id: null,
                })
              : [];
          case "follow_link": {
            const el = e.elements.find((x) => x.id === a.id);
            if (!el?.link) throw Error("Link not found");
            const link = el.link;
            if (link.path) {
              if (!agent.grant?.files) throw Error("FILE_PERMISSION_REQUIRED");
              if (link.path.toLowerCase().endsWith(".lightpen")) {
                const loaded = await file("read_board", link.path, "lightpen");
                if (
                  link.elementId &&
                  !loaded.document.elements.some(
                    (x: { id: string }) => x.id === link.elementId,
                  )
                )
                  throw Error("Target missing");
                await switchTo(loaded.document, loaded.path, a);
              } else {
                if (!native) throw Error("DESKTOP_REQUIRED");
                await invoke("agent_open_link", {
                  session: a.session,
                  path: link.path,
                });
                return { opened: true };
              }
            }
            if (link.elementId) {
              if (!e.elements.some((x) => x.id === link.elementId))
                throw Error("Target missing");
              e.focusElement(link.elementId);
            }
            return { opened: true, focused: link.elementId };
          }
          case "recent": {
            if (!a.id) throw Error("id required");
            await saver.flush();
            if (!native)
              throw Error(
                "DESKTOP_REQUIRED: recent board access requires the desktop app",
              );
            const r = await invoke<
              import("../platform/native").RestoredSession
            >("agent_recent", {
              session: a.session,
              currentId: e.document.id,
              id: a.id,
            });
            unchanged(a);
            if (!r.document) throw Error("Document not found");
            return switchTo(r.document, r.path, a);
          }
          case "open": {
            if (!a.path) throw Error("path required");
            const r = await file("read_board", a.path, "lightpen");
            return switchTo(r.document, r.path, a);
          }
          case "save": {
            if (!saver.path) {
              if (a.path) return handlers.document({ ...a, action: "save_as" });
              saver.schedule(e.document, null);
              await saver.flush();
              return { draft: true, revision: e.document.revision };
            }
            saver.schedule(e.document);
            await saver.flush();
            return { path: saver.path, revision: e.document.revision };
          }
          case "save_as": {
            if (!a.path) throw Error("path required");
            await saver.flush();
            unchanged(a);
            const doc = e.document,
              r = await file("write_board", a.path, "lightpen", {
                document: doc,
                overwrite: a.overwrite ?? false,
              });
            unchanged(a);
            saver.reset(r.path);
            saver.schedule(doc);
            await saver.flush();
            return { path: r.path, revision: doc.revision };
          }
        }
      },
      versions: async (a) => {
        switch (a.action) {
          case "list":
            return versions(e.document.id);
          case "read":
            if (!a.version) throw Error("version required");
            return paged(await readVersion(e.document.id, a.version), a);
          case "create":
            await saver.flush();
            unchanged(a);
            await checkpoint(e.document);
            return versions(e.document.id);
          case "restore": {
            if (e.readOnly) throw Error("READ_ONLY");
            if (!a.version) throw Error("version required");
            const doc = await readVersion(e.document.id, a.version);
            await saver.flush();
            unchanged(a);
            await checkpoint(e.document);
            unchanged(a);
            e.commit(doc.elements, "Восстановление версии ИИ", doc.title);
            await saver.flush();
            return { restored: a.version };
          }
        }
      },
      templates: async (a) => {
        switch (a.action) {
          case "list":
            return (await listTemplates()).map(({ elements, ...rest }) => ({
              ...rest,
              previewObjects: elements.length,
            }));
          case "read":
            if (!a.id) throw Error("id required");
            return paged(await readTemplate(a.id), a);
          case "save": {
            if (!e.selection.length) throw Error("Selection is empty");
            const doc = {
              ...createDocument(a.title || "Шаблон"),
              elements: structuredClone(e.selection),
            };
            await saveTemplate(doc);
            return { id: doc.id, title: doc.title };
          }
          case "insert": {
            if (e.readOnly) throw Error("READ_ONLY");
            if (!a.id) throw Error("id required");
            const doc = await readTemplate(a.id);
            unchanged(a);
            e.insertElements(doc.elements);
            return { created: [...e.selected] };
          }
          case "remove":
            if (!a.id) throw Error("id required");
            await removeTemplate(a.id);
            return { removed: a.id };
          case "import": {
            if (!a.path) throw Error("path required");
            const r = await file("read_board", a.path, "lightpen-template");
            unchanged(a);
            const doc = {
              ...createDocument(r.document.title),
              elements: copyElements(r.document.elements, 0, 0),
            };
            await saveTemplate(doc);
            return { id: doc.id };
          }
          case "export": {
            if (!a.path || !a.id) throw Error("path and id required");
            const doc = await readTemplate(a.id);
            return file("write_board", a.path, "lightpen-template", {
              document: doc,
              overwrite: a.overwrite ?? false,
            });
          }
        }
      },
      image_import: async (a) => {
        if (e.readOnly) throw Error("READ_ONLY");
        const extension = a.path.split(".").pop().toLowerCase(),
          r = await file("read_image", a.path, extension);
        const image = new Image();
        image.src = r.dataUrl;
        await image.decode();
        if (
          !image.naturalWidth ||
          !image.naturalHeight ||
          image.naturalWidth * image.naturalHeight > 32_000_000
        )
          throw Error("Image exceeds 32 MP or is invalid");
        unchanged(a);
        e.addImage(r.dataUrl, image.naturalWidth, image.naturalHeight);
        return { created: [...e.selected] };
      },
      board_preview: async (a) => {
        const result = await exportPng({ ...a, maxSize: a.maxSize ?? 1200 });
        const img = new Image();
        img.src = result.dataUrl;
        await img.decode();
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        let dataUrl: string;
        do {
          canvas
            .getContext("2d")!
            .drawImage(img, 0, 0, canvas.width, canvas.height);
          dataUrl = canvas.toDataURL("image/png");
          if (dataUrl.length <= 4 * 1024 * 1024) break;
          canvas.width = Math.max(128, Math.floor(canvas.width * 0.75));
          canvas.height = Math.max(128, Math.floor(canvas.height * 0.75));
        } while (true);
        return { dataUrl, width: canvas.width, height: canvas.height };
      },
      export: async (a) => {
        let data: string;
        if (a.format === "png")
          data = (await exportPng(a)).dataUrl.split(",")[1];
        else if (a.format === "csv" || a.format === "tsv") {
          let cells: string[][];
          if (a.tableId) {
            const t = e.elements.find(
              (t) => t.id === a.tableId && t.kind === "table" && !t.hidden,
            );
            if (!t) throw Error("Table not found");
            cells = t.cells!;
          } else
            cells = [
              [
                "ID",
                "Название",
                "Статус",
                "Начало",
                "Срок",
                "Приоритет",
                "Часы",
                "Теги",
                "Описание",
              ],
              ...queryTasks(e.elements, { archived: true }).map((t) => [
                t.id,
                t.text ?? "",
                t.task.status,
                t.task.start ?? "",
                t.task.due ?? "",
                t.task.priority ?? "none",
                String(t.task.estimate ?? ""),
                t.task.tags?.join(", ") ?? "",
                t.task.description ?? "",
              ]),
            ];
          data = toCsv(cells, true, a.format === "csv" ? "," : "\t");
        } else {
          const { exportSvg, exportPdf } =
            await import("../editor/render/vector-export");
          const ids = a.scope === "selection" ? new Set(e.selected) : undefined;
          if (ids && !ids.size) throw Error("Selection is empty");
          const frame =
            a.scope === "frame"
              ? e.slides.find((f) => f.id === a.frameId)
              : undefined;
          if (a.scope === "frame" && !frame) throw Error("Frame not found");
          if (a.format === "svg")
            data = (await exportSvg(e.document, { ids, frameId: frame?.id }))
              .svg;
          else {
            const bytes = await exportPdf(e.document, {
              ids,
              frames:
                a.scope === "slides" ? e.slides : frame ? [frame] : undefined,
            });
            let binary = "";
            for (let i = 0; i < bytes.length; i += 8192)
              binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
            data = btoa(binary);
          }
        }
        if (!agent.grant || agent.grant.session !== a.session)
          throw Error("ACCESS_REVOKED");
        return file("write", a.path, a.format, {
          data,
          overwrite: a.overwrite ?? false,
        });
      },
      presentation: async (a) => {
        if (a.action === "start") {
          if (!e.slides.length) throw Error("No frames to present");
          ui.present(true);
          return { presenting: true };
        }
        if (a.action === "stop") {
          ui.present(false);
          return { presenting: false };
        }
        return service("presentation_control", a);
      },
      workspace_ui: async (a) => {
        if (a.action === "close") {
          const panel = e.agentPanel;
          if (!panel?.isOpen())
            throw Error("USER_INPUT_REQUIRED: no agent-owned dialog to close");
          const dialogs = [
            ...document.querySelectorAll('[role="dialog"]'),
          ].filter(
            (el) =>
              el.getClientRects().length > 0 &&
              !el.classList.contains("agent-dialog"),
          );
          if (
            dialogs.length !== 1 ||
            document.activeElement?.matches(
              "input:not([readonly]),textarea:not([readonly]),[contenteditable=true]",
            )
          )
            throw Error("BUSY: leave active user input untouched");
          e.agentPanel = null;
          panel.close();
          return { closed: panel.kind };
        }
        if (
          [
            "properties",
            "objects",
            "insert",
            "templates",
            "search",
            "frames",
          ].includes(a.action)
        ) {
          e.dock = a.action;
          e.emit("ui");
          return { panel: a.action };
        }
        if (a.action === "help") {
          ui.help();
          return { panel: "help" };
        }
        if (a.action === "export") {
          ui.export();
          return { panel: "export" };
        }
        return service("panel_" + a.action, a);
      },
    };
  function service(name: string, a: Record<string, any>) {
    const fn = e.services.get(name);
    if (!fn) throw Error(`UNAVAILABLE: ${name}`);
    return fn(a);
  }
  function paged(doc: BoardDocument, a: Record<string, any>) {
    const { elements, ...meta } = doc,
      offset = a.offset ?? 0,
      limit = a.limit ?? 100,
      pointOffset = a.pointOffset ?? 0,
      pointLimit = a.pointLimit ?? 10000;
    if (![offset, limit, pointOffset, pointLimit].every(Number.isSafeInteger))
      throw Error("Page values must be integers");
    return {
      ...meta,
      total: elements.length,
      offset,
      next: offset + limit < elements.length ? offset + limit : null,
      elements: elements.slice(offset, offset + limit).map((el) => {
        const { dataUrl, points, ...rest } = el;
        return {
          ...rest,
          ...(dataUrl
            ? {
                asset: { embedded: true, characters: dataUrl.length },
                ...(a.includeAssets ? { dataUrl } : {}),
              }
            : {}),
          ...(points
            ? {
                pointCount: points.length,
                ...(a.includePoints
                  ? {
                      points: points.slice(
                        pointOffset,
                        pointOffset + pointLimit,
                      ),
                    }
                  : {}),
              }
            : {}),
        };
      }),
    };
  }
  function palette(key: string) {
    try {
      const value = JSON.parse(localStorage.getItem(key) ?? "[]");
      return Array.isArray(value)
        ? value
            .filter((c) => typeof c === "string" && /^#[a-f\d]{6}$/i.test(c))
            .slice(0, 12)
        : [];
    } catch {
      return [];
    }
  }
  for (const [name, fn] of Object.entries(handlers)) e.services.set(name, fn);
  return () => {
    for (const [name, fn] of Object.entries(handlers))
      if (e.services.get(name) === fn) e.services.delete(name);
  };
}
