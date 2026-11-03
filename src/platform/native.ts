import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { validateDocument } from "../editor/model/types";
import type { BoardDocument } from "../editor/model/types";
import type { DocumentBackend } from "./persistence";

export interface RestoredSession {
  document: BoardDocument | null;
  path: string | null;
  warning?: string | null;
  needsSave?: boolean;
}
export interface RecentDocument {
  id: string;
  title: string;
  path: string | null;
  updatedAt: string;
}
export interface DocumentVersion {
  id: string;
  timestamp: number;
  revision: number;
  objects: number;
  manual: boolean;
  bytes: number;
}
export async function versions(id: string): Promise<DocumentVersion[]> {
  if (native) return invoke("list_versions", { id });
  const snapshots = JSON.parse(
    localStorage.getItem(`lightpen.versions.${id}`) ?? "[]",
  ) as { id: string; timestamp: number; document: BoardDocument }[];
  return snapshots.map((s) => ({
    id: s.id,
    timestamp: s.timestamp,
    revision: s.document.revision,
    objects: s.document.elements.length,
    manual: true,
    bytes: JSON.stringify(s.document).length,
  }));
}
export async function checkpoint(document: BoardDocument) {
  if (native) {
    await invoke("create_checkpoint", { document });
    return;
  }
  const key = `lightpen.versions.${document.id}`,
    snapshots = JSON.parse(localStorage.getItem(key) ?? "[]");
  localStorage.setItem(
    key,
    JSON.stringify(
      [
        { id: crypto.randomUUID(), timestamp: Date.now(), document },
        ...snapshots,
      ].slice(0, 20),
    ),
  );
}
export async function readVersion(
  id: string,
  version: string,
): Promise<BoardDocument> {
  if (native)
    return validateDocument(await invoke("read_version", { id, version }));
  const snapshots = JSON.parse(
    localStorage.getItem(`lightpen.versions.${id}`) ?? "[]",
  ) as { id: string; document: BoardDocument }[];
  const snapshot = snapshots.find((s) => s.id === version);
  if (!snapshot) throw new Error("Версия не найдена.");
  return validateDocument(snapshot.document);
}
export const native = isTauri();
export type TemplateSummary = Pick<
  BoardDocument,
  "id" | "title" | "elements"
> & { objects: number };
export async function listTemplates(): Promise<TemplateSummary[]> {
  if (native) return invoke<TemplateSummary[]>("list_templates");
  return (
    JSON.parse(localStorage.getItem("lightpen.templates") ?? "[]") as unknown[]
  )
    .map(validateDocument)
    .map((d) => ({ ...d, objects: d.elements.length }));
}
export async function readTemplate(id: string): Promise<BoardDocument> {
  if (native) return validateDocument(await invoke("read_template", { id }));
  const docs = (
    JSON.parse(localStorage.getItem("lightpen.templates") ?? "[]") as unknown[]
  ).map(validateDocument);
  const doc = docs.find((d) => d.id === id);
  if (!doc) throw new Error("Шаблон не найден.");
  return doc;
}
export async function saveTemplate(document: BoardDocument) {
  validateDocument(document);
  if (!document.elements.length) throw new Error("В шаблоне нет объектов.");
  if (native) return invoke<void>("save_template", { document });
  const list = await listTemplates();
  localStorage.setItem(
    "lightpen.templates",
    JSON.stringify(
      [document, ...list.filter((d) => d.id !== document.id)].slice(0, 128),
    ),
  );
}
export async function removeTemplate(id: string) {
  if (native) return invoke<void>("remove_template", { id });
  localStorage.setItem(
    "lightpen.templates",
    JSON.stringify((await listTemplates()).filter((d) => d.id !== id)),
  );
}
export async function importTemplate(): Promise<BoardDocument | null> {
  if (native) {
    const path = await open({
      title: "Импорт шаблона",
      multiple: false,
      filters: [
        {
          name: "Шаблон Light Pen",
          extensions: ["lightpen-template", "lightpen"],
        },
      ],
    });
    return typeof path === "string" ? readDocument(path) : null;
  }
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.lightpen-template";
    input.oncancel = () => resolve(null);
    input.onchange = async () => {
      try {
        const f = input.files?.[0];
        resolve(f ? validateDocument(JSON.parse(await f.text())) : null);
      } catch (e) {
        reject(e);
      }
    };
    input.click();
  });
}
export async function exportTemplate(document: BoardDocument) {
  if (native) {
    const path = await save({
      title: "Экспорт шаблона",
      defaultPath: `${document.title.replace(/[<>:"/\\|?*]/g, "_")}.lightpen-template`,
      filters: [
        { name: "Шаблон Light Pen", extensions: ["lightpen-template"] },
      ],
    });
    if (path)
      await invoke("export_template", {
        path: suffix(path, "lightpen-template"),
        document,
      });
  } else
    download(
      new Blob([JSON.stringify(document)], { type: "application/json" }),
      `${document.title}.lightpen-template`,
    );
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export async function saveVector(
  data: string | Uint8Array,
  title: string,
  format: "svg" | "pdf",
): Promise<boolean> {
  if (native) {
    const path = await save({
      title: `Экспорт ${format.toUpperCase()}`,
      defaultPath: `${title.replace(/[<>:"/\\|?*]/g, "_")}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (!path) return false;
    let encoded: string;
    if (typeof data === "string") encoded = data;
    else {
      let binary = "";
      for (let i = 0; i < data.length; i += 8192)
        binary += String.fromCharCode(...data.subarray(i, i + 8192));
      encoded = btoa(binary);
    }
    await invoke("export_vector", {
      path: suffix(path, format),
      data: encoded,
      format,
    });
  } else
    download(
      new Blob([typeof data === "string" ? data : new Uint8Array(data)], {
        type: format === "svg" ? "image/svg+xml" : "application/pdf",
      }),
      `${title}.${format}`,
    );
  return true;
}
export async function chooseLocalLink(): Promise<string | null> {
  if (!native) return null;
  const path = await open({
    title: "Выберите доску или локальный файл",
    multiple: false,
  });
  return typeof path === "string" ? path : null;
}
export async function openLocalFile(path: string) {
  if (native) await invoke("open_local_file", { path });
  else throw new Error("Локальные файлы открываются в настольной версии.");
}
const suffix = (path: string, extension: string) =>
  path.toLowerCase().endsWith(`.${extension}`) ? path : `${path}.${extension}`;
export const backend: DocumentBackend = {
  async persist(document, path) {
    if (native) {
      await invoke("persist_document", { document, path });
      return;
    }
    localStorage.setItem(
      "lightpen.preview.recovery",
      JSON.stringify({ document, path }),
    );
    const drafts = JSON.parse(
      localStorage.getItem("lightpen.preview.drafts") ?? "[]",
    ) as RestoredSession[];
    localStorage.setItem(
      "lightpen.preview.drafts",
      JSON.stringify(
        [
          { document, path },
          ...drafts.filter((d) => d.document?.id !== document.id),
        ].slice(0, 20),
      ),
    );
  },
};
export async function restoreSession(): Promise<RestoredSession> {
  if (native) {
    const result = await invoke<RestoredSession>("restore_session");
    if (result.document) validateDocument(result.document);
    return result;
  }
  const value = localStorage.getItem("lightpen.preview.recovery");
  if (!value) return { document: null, path: null };
  const result = JSON.parse(value) as RestoredSession;
  if (result.document) validateDocument(result.document);
  return result;
}
export async function chooseDocument(onPicked: () => void = () => {}): Promise<{
  document: BoardDocument;
  path: string;
} | null> {
  if (native) {
    const path = await open({
      title: "Открыть доску",
      multiple: false,
      filters: [{ name: "Доска Light Pen", extensions: ["lightpen"] }],
    });
    onPicked();
    if (!path || Array.isArray(path)) return null;
    return { document: await readDocument(path), path };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.oncancel = () => {
      onPicked();
      resolve(null);
    };
    input.onchange = async () => {
      onPicked();
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      try {
        resolve({
          document: validateDocument(JSON.parse(await file.text())),
          path: file.name,
        });
      } catch {
        resolve(null);
      }
    };
    input.click();
  });
}
export async function readDocument(path: string) {
  return validateDocument(
    await invoke<BoardDocument>("open_document", { path }),
  );
}
export async function recentDocuments(): Promise<RecentDocument[]> {
  if (native) return invoke("list_recent_documents");
  const drafts = JSON.parse(
    localStorage.getItem("lightpen.preview.drafts") ?? "[]",
  ) as RestoredSession[];
  return drafts
    .filter((d) => d.document)
    .map((d) => ({
      id: d.document!.id,
      title: d.document!.title,
      path: d.path,
      updatedAt: d.document!.updatedAt,
    }));
}
export async function openRecentDocument(id: string): Promise<RestoredSession> {
  if (native) {
    const loaded = await invoke<RestoredSession>("open_recent_document", {
      id,
    });
    if (loaded.document) validateDocument(loaded.document);
    return loaded;
  }
  const drafts = JSON.parse(
    localStorage.getItem("lightpen.preview.drafts") ?? "[]",
  ) as RestoredSession[];
  const result = drafts.find((d) => d.document?.id === id);
  if (!result?.document) throw new Error("Черновик не найден.");
  validateDocument(result.document);
  return result;
}
export async function chooseSavePath(title: string): Promise<string | null> {
  if (!native) return `${title}.lightpen`;
  const path = await save({
    title: "Сохранить доску",
    defaultPath: `${title.replace(/[<>:"/\\|?*]/g, "_")}.lightpen`,
    filters: [{ name: "Доска Light Pen", extensions: ["lightpen"] }],
  });
  return path ? suffix(path, "lightpen") : null;
}
export async function savePng(
  dataUrl: string,
  title: string,
  onPicked: () => void = () => {},
): Promise<boolean> {
  if (native) {
    const path = await save({
      title: "Экспортировать PNG",
      defaultPath: `${title.replace(/[<>:"/\\|?*]/g, "_")}.png`,
      filters: [{ name: "Изображение PNG", extensions: ["png"] }],
    });
    onPicked();
    if (!path) return false;
    await invoke("export_png", { path: suffix(path, "png"), dataUrl });
    return true;
  }
  onPicked();
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = `${title}.png`;
  anchor.click();
  return true;
}
