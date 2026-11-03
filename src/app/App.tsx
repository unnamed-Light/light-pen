import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  FluentProvider,
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Slider,
  Spinner,
  Tooltip,
  webDarkTheme,
  webLightTheme,
} from "@fluentui/react-components";
import {
  ArrowDownload20Regular,
  ArrowRedo20Regular,
  ArrowUndo20Regular,
  CheckmarkCircle16Regular,
  ChevronDown16Regular,
  Dismiss20Regular,
  DocumentAdd20Regular,
  FolderOpen20Regular,
  FullScreenMaximize20Regular,
  Image20Regular,
  Pause20Regular,
  Play20Regular,
  QuestionCircle20Regular,
  Save20Regular,
  Stop20Regular,
  WeatherMoon20Regular,
  WeatherSunny20Regular,
  ZoomIn20Regular,
  ZoomOut20Regular,
} from "@fluentui/react-icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Editor, exampleDocument } from "../editor/editor";
import { createDocument } from "../editor/model/types";
import type { BoardDocument, Tool } from "../editor/model/types";
import type { BoardRenderer } from "../editor/render/renderer";
import {
  backend,
  chooseDocument,
  chooseSavePath,
  native,
  openRecentDocument,
  readDocument,
  recentDocuments,
  restoreSession,
  savePng,
} from "../platform/native";
import type { RecentDocument } from "../platform/native";
import { SaveCoordinator } from "../platform/persistence";
import { CanvasView } from "./CanvasView";
import { ToolIcon } from "./ToolIcon";

import { BoardFeatures } from "./BoardFeatures";
import { Studio, PropertyDock } from "./Studio";
import { Minimap, Presentation } from "./Navigation";
import { ExportDialog } from "./ExportDialog";
import type { ExportScope } from "./ExportDialog";
import { parseTsv } from "../editor/model/tables";
import { saveVector, openLocalFile } from "../platform/native";
import { keyboardCode } from "../platform/keyboard";

const TOOLS: { tool: Tool; name: string; key: string }[] = [
  { tool: "select", name: "Выделение", key: "V" },
  { tool: "hand", name: "Рука", key: "H" },
  { tool: "pen", name: "Перо", key: "P" },
  { tool: "highlighter", name: "Маркер", key: "M" },
  { tool: "eraser", name: "Ластик", key: "E" },
  { tool: "rectangle", name: "Прямоугольник", key: "R" },
  { tool: "ellipse", name: "Эллипс", key: "O" },
  { tool: "diamond", name: "Ромб", key: "D" },
  { tool: "arrow", name: "Стрелка", key: "A" },
  { tool: "line", name: "Линия", key: "L" },
  { tool: "text", name: "Текст", key: "T" },
  { tool: "sticky", name: "Стикер", key: "N" },
  { tool: "connector", name: "Соединитель", key: "C" },
  { tool: "frame", name: "Фрейм", key: "F" },
  { tool: "math", name: "Формула LaTeX", key: "Q" },
];
const TOOL_CODES: Record<string, Tool> = {
  KeyV: "select",
  KeyH: "hand",
  KeyP: "pen",
  KeyM: "highlighter",
  KeyE: "eraser",
  KeyR: "rectangle",
  KeyO: "ellipse",
  KeyD: "diamond",
  KeyA: "arrow",
  KeyL: "line",
  KeyT: "text",
  KeyN: "sticky",
  KeyC: "connector",
  KeyF: "frame",
  KeyQ: "math",
};

export function App() {
  const [editor] = useState(() => new Editor());
  const [saver] = useState(
    () => new SaveCoordinator(backend, () => !editor.isInteracting),
  );
  useSyncExternalStore(editor.subscribeUi, editor.getSnapshot);
  useSyncExternalStore(saver.subscribe, saver.getSnapshot);
  const [dark, setDark] = useState(() => {
    const v = localStorage.getItem("lightpen.theme");
    return v
      ? v === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
  });
  const [ready, setReady] = useState(false),
    [exportOpen, setExportOpen] = useState(false),
    [presenting, setPresenting] = useState(false),
    [busy, setBusy] = useState(false),
    [waitingForFile, setWaitingForFile] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [help, setHelp] = useState(false),
    [closeError, setCloseError] = useState(false),
    [title, setTitle] = useState(editor.document.title);
  const [recents, setRecents] = useState<RecentDocument[]>([]),
    [recentOpen, setRecentOpen] = useState(false),
    [dismissedError, setDismissedError] = useState("");
  const painter = useRef<BoardRenderer | null>(null),
    importInput = useRef<HTMLInputElement>(null),
    closing = useRef(false),
    actionLock = useRef(false);
  const rendererReady = useCallback((renderer: BoardRenderer | null) => {
    painter.current = renderer;
  }, []);
  const notify = useCallback((text: string) => {
    setMessage(text);
  }, []);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(""), 3500);
    return () => clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    setTitle(editor.document.title);
    setPresenting(false);
  }, [editor.document.title, editor.document.id]);
  useEffect(() => {
    if (!native || !presenting) return;
    const window = getCurrentWindow();
    let previous = false,
      cancelled = false;
    const entering = window
      .isFullscreen()
      .then((value) => {
        previous = value;
        if (!cancelled) return window.setFullscreen(true);
      })
      .catch((error) => {
        setError(String(error));
        setPresenting(false);
      });
    return () => {
      cancelled = true;
      void entering.then(() => window.setFullscreen(previous)).catch(() => {});
    };
  }, [presenting]);
  useEffect(() => {
    localStorage.setItem("lightpen.theme", dark ? "dark" : "light");
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    if (native)
      void getCurrentWindow()
        .setTheme(dark ? "dark" : "light")
        .catch(() => {});
  }, [dark]);
  useEffect(() => {
    let cancelled = false;
    const off = editor.subscribe((signal) => {
      if (signal === "document") saver.schedule(editor.document);
    });
    void (async () => {
      try {
        const restored = await restoreSession();
        if (cancelled) return;
        const startup = native
          ? await invoke<string | null>("startup_path")
          : null;
        let initial = restored.document ?? exampleDocument();
        let initialPath = restored.document ? restored.path : null;
        let needsWrite = !restored.document || !!restored.needsSave;
        let warning = restored.warning;
        if (startup) {
          try {
            initial = await readDocument(startup);
            initialPath = startup;
            needsWrite = true;
          } catch (openError) {
            warning = `Не удалось открыть выбранный файл. Предыдущая доска восстановлена. ${String(openError)}`;
          }
        }
        if (cancelled) return;
        editor.setDocument(initial);
        saver.reset(initialPath);
        if (needsWrite) saver.schedule(initial);
        if (warning) setError(warning);
      } catch (e) {
        if (!cancelled) {
          editor.setDocument(createDocument());
          saver.reset(null);
          setError(String(e));
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
      off();
      saver.dispose();
    };
  }, [editor, saver]);
  useEffect(() => {
    if (native)
      void getCurrentWindow()
        .setTitle(`${editor.document.title} — Light Pen`)
        .catch(() => {});
  }, [editor.document.title]);
  const action = useCallback(
    async (fn: () => Promise<void>) => {
      if (actionLock.current) return;
      actionLock.current = true;
      setBusy(true);
      if (document.activeElement instanceof HTMLInputElement)
        document.activeElement.blur();
      editor.commitText();
      editor.endStyle();
      editor.cancelGesture();
      editor.enabled = false;
      setError("");
      try {
        await fn();
      } catch (e) {
        setError(String(e instanceof Error ? e.message : e));
      } finally {
        editor.enabled = true;
        actionLock.current = false;
        setBusy(false);
        setWaitingForFile(false);
      }
    },
    [editor],
  );
  const openPath = useCallback(
    (path: string) =>
      action(async () => {
        await saver.flush();
        const doc = await readDocument(path);
        editor.setDocument(doc);
        saver.reset(path);
        saver.schedule(doc);
        notify("Доска открыта");
      }),
    [action, editor, saver, notify],
  );
  useEffect(() => {
    if (!native) return;
    let unlistenClose: (() => void) | undefined,
      unlistenOpen: (() => void) | undefined,
      disposed = false;
    void getCurrentWindow()
      .onCloseRequested(async (e) => {
        e.preventDefault();
        if (closing.current) return;
        closing.current = true;
        editor.commitText();
        editor.endStyle();
        editor.cancelGesture();
        editor.enabled = false;
        try {
          await saver.flush();
          await getCurrentWindow().destroy();
        } catch {
          closing.current = false;
          editor.enabled = true;
          setCloseError(true);
        }
      })
      .then((off) => {
        if (disposed) off();
        else unlistenClose = off;
      });
    void listen<string>("open-file", (event) => {
      void openPath(event.payload);
    }).then((off) => {
      if (disposed) off();
      else unlistenOpen = off;
    });
    return () => {
      disposed = true;
      unlistenClose?.();
      unlistenOpen?.();
    };
  }, [editor, saver, openPath]);
  const newBoard = useCallback(
    () =>
      action(async () => {
        await saver.flush();
        editor.setDocument(createDocument());
        saver.reset(null);
        saver.schedule(editor.document);
      }),
    [action, editor, saver],
  );
  const openBoard = useCallback(
    () =>
      action(async () => {
        await saver.flush();
        setWaitingForFile(true);
        const loaded = await chooseDocument(() => setWaitingForFile(false));
        if (!loaded) return;
        editor.setDocument(loaded.document);
        saver.reset(loaded.path);
        saver.schedule(loaded.document);
        notify("Доска открыта");
      }),
    [action, editor, saver, notify],
  );
  const saveBoard = useCallback(
    (as = false) =>
      action(async () => {
        let path = saver.path;
        if (as || !path) {
          setWaitingForFile(true);
          path = await chooseSavePath(editor.document.title);
          setWaitingForFile(false);
        }
        if (!path) return;
        saver.schedule(editor.document, path);
        await saver.flush();
        notify("Доска сохранена");
      }),
    [action, editor, saver, notify],
  );
  const exportBoard = useCallback(
    (frameId?: string) =>
      action(async () => {
        if (!painter.current) return;
        const result = await painter.current.exportPng(
          editor.selected.size > 0,
          frameId,
        );
        setWaitingForFile(true);
        if (
          await savePng(result.dataUrl, editor.document.title, () =>
            setWaitingForFile(false),
          )
        )
          notify(`PNG сохранён · ${result.width} × ${result.height}`);
      }),
    [action, editor, notify],
  );
  const exportDocument = (format: "png" | "svg" | "pdf", scope: ExportScope) =>
    void action(async () => {
      const ids = scope === "selection" ? new Set(editor.selected) : undefined;
      let data: string | Uint8Array;
      if (format === "png") {
        if (!painter.current) return;
        const png = await painter.current.exportPng(scope === "selection");
        setWaitingForFile(true);
        if (
          await savePng(png.dataUrl, editor.document.title, () =>
            setWaitingForFile(false),
          )
        )
          notify("PNG сохранён");
      } else {
        const { exportSvg, exportPdf } =
          await import("../editor/render/vector-export");
        data =
          format === "svg"
            ? (await exportSvg(editor.document, { ids })).svg
            : await exportPdf(editor.document, {
                ids,
                frames: scope === "slides" ? editor.slides : undefined,
              });
        setWaitingForFile(true);
        if (await saveVector(data, editor.document.title, format))
          notify(`${format.toUpperCase()} сохранён`);
      }
      setExportOpen(false);
    });
  const linkRequest = editor.linkRequest;
  useEffect(() => {
    if (!linkRequest) return;
    editor.linkRequest = null;
    void action(async () => {
      const { path, elementId } = linkRequest;
      if (!path) {
        if (!elementId || !editor.elements.some((e) => e.id === elementId))
          throw new Error(
            "Объект по ссылке не найден. Проверьте назначение ссылки.",
          );
        editor.focusElement(elementId);
        return;
      }
      if (path.toLowerCase().endsWith(".lightpen")) {
        await saver.flush();
        const doc = await readDocument(path);
        if (elementId && !doc.elements.some((e) => e.id === elementId))
          throw new Error(
            "Файл найден, но объект по ссылке удалён. Выберите новое назначение.",
          );
        editor.setDocument(doc);
        saver.reset(path);
        saver.schedule(doc);
        if (elementId) editor.focusElement(elementId);
        notify("Связанная доска открыта");
      } else await openLocalFile(path);
    });
  }, [linkRequest, action, editor, saver, notify]);
  const loadExample = useCallback(
    () =>
      action(async () => {
        await saver.flush();
        editor.setDocument(exampleDocument());
        saver.reset(null);
        saver.schedule(editor.document);
      }),
    [action, editor, saver],
  );
  const showRecents = useCallback(
    () =>
      action(async () => {
        await saver.flush();
        setRecents(await recentDocuments());
        setRecentOpen(true);
      }),
    [action, saver],
  );
  const openRecent = useCallback(
    (id: string) =>
      action(async () => {
        await saver.flush();
        const loaded = await openRecentDocument(id);
        if (!loaded.document) return;
        editor.setDocument(loaded.document);
        saver.reset(loaded.path);
        if (loaded.needsSave) saver.schedule(loaded.document);
        if (loaded.warning) setError(loaded.warning);
        setRecentOpen(false);
      }),
    [action, editor, saver],
  );
  const importImage = useCallback(
    async (file: File) => {
      await action(async () => {
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
          throw new Error("Выберите изображение PNG, JPG или WebP.");
        if (file.size > 20 * 1024 * 1024)
          throw new Error("Изображение должно быть меньше 20 МБ.");
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () =>
            reject(new Error("Не удалось прочитать изображение."));
          reader.readAsDataURL(file);
        });
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        if (!image.naturalWidth || !image.naturalHeight)
          throw new Error("Не удалось открыть изображение.");
        if (image.naturalWidth * image.naturalHeight > 32_000_000)
          throw new Error("Выберите изображение до 32 мегапикселей.");
        editor.addImage(dataUrl, image.naturalWidth, image.naturalHeight);
      });
    },
    [action, editor],
  );
  useEffect(() => {
    const keyDown = (e: KeyboardEvent) => {
      const code = keyboardCode(e);
      if (e.defaultPrevented) return;
      if (
        !ready ||
        editor.presenting ||
        actionLock.current ||
        document.querySelector('[role="dialog"]')
      )
        return;
      const control = e.ctrlKey || e.metaKey;
      if (code === "F5") {
        e.preventDefault();
        if (editor.slides.length) setPresenting(true);
        return;
      }
      if (control && code === "KeyS") {
        e.preventDefault();
        void saveBoard(e.shiftKey);
        return;
      }
      if (control && code === "KeyO") {
        e.preventDefault();
        void openBoard();
        return;
      }
      if (control && code === "KeyN") {
        e.preventDefault();
        void newBoard();
        return;
      }
      if (
        (e.target as HTMLElement)?.closest(
          "input:not([type=range]), textarea, [contenteditable=true]",
        )
      )
        return;
      if (control) {
        const actions: Record<string, () => void> = {
          KeyZ: () => (e.shiftKey ? editor.redo() : editor.undo()),
          KeyY: () => editor.redo(),
          KeyD: () => editor.duplicate(),
          KeyA: () => editor.selectAll(),
          KeyC: () => editor.copy(),
          Equal: () => editor.zoom(1.2),
          Minus: () => editor.zoom(1 / 1.2),
          Digit0: () => editor.zoom(1 / editor.camera.zoom),
        };
        const handler = actions[code];
        if (handler) {
          e.preventDefault();
          if (!editor.replay) handler();
        }
        return;
      }
      if (code === "Space") {
        e.preventDefault();
        if (editor.replay) {
          if (!e.repeat) editor.toggleReplay();
        } else {
          editor.spaceHeld = true;
          editor.emit("ui");
        }
        return;
      }
      if (code === "Escape") {
        editor.cancelGesture();
        editor.cancelText();
        editor.stopReplay();
        editor.selected.clear();
        editor.emit("ui");
        editor.emit("overlay");
        return;
      }
      if (editor.replay) return;
      if (code === "Delete" || code === "Backspace") {
        e.preventDefault();
        editor.deleteSelection();
        return;
      }
      if (code === "Digit1" && e.shiftKey) {
        e.preventDefault();
        editor.fit();
        return;
      }
      if (code === "Digit2" && e.shiftKey) {
        e.preventDefault();
        editor.fit(true);
        return;
      }
      if (code === "F1") {
        e.preventDefault();
        setHelp(true);
        return;
      }
      const tool = TOOL_CODES[code];
      if (tool) {
        e.preventDefault();
        editor.setTool(tool);
      }
    };
    const keyUp = (e: KeyboardEvent) => {
      if (keyboardCode(e) === "Space") {
        editor.spaceHeld = false;
        editor.emit("ui");
      }
    };
    const unload = (e: BeforeUnloadEvent) => {
      if (saver.status !== "saved") {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    if (!native) window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("beforeunload", unload);
    };
  }, [editor, saver, ready, saveBoard, openBoard, newBoard]);
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (
        !ready ||
        actionLock.current ||
        editor.replay ||
        editor.presenting ||
        document.querySelector('[role="dialog"]') ||
        (event.target instanceof Element &&
          event.target.closest("input,textarea,[contenteditable=true]"))
      )
        return;
      const image = [...(event.clipboardData?.items ?? [])]
        .find((i) => i.kind === "file" && i.type.startsWith("image/"))
        ?.getAsFile();
      event.preventDefault();
      if (image) void importImage(image);
      else {
        const value = event.clipboardData?.getData("text/plain") ?? "";
        if (value.includes("\t")) {
          try {
            editor.addStructured("table", parseTsv(value));
          } catch (e) {
            setError(String(e));
          }
        } else editor.paste();
      }
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [editor, ready, importImage]);
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const target = window as unknown as { __LIGHT_PEN_TEST__?: unknown };
    target.__LIGHT_PEN_TEST__ = {
      editor,
      saver,
      get renderer() {
        return painter.current;
      },
    };
    return () => {
      delete target.__LIGHT_PEN_TEST__;
    };
  }, [editor, saver]);

  const status =
    saver.status === "error"
      ? "Не удалось сохранить"
      : saver.status === "saved"
        ? saver.path
          ? "Сохранено"
          : "Черновик сохранён"
        : saver.status === "saving"
          ? "Сохранение…"
          : "Есть изменения";
  const rawError = error || saver.error,
    currentError = rawError === dismissedError ? "" : rawError;
  useEffect(() => {
    if (!rawError) setDismissedError("");
  }, [rawError]);
  return (
    <FluentProvider
      theme={dark ? webDarkTheme : webLightTheme}
      className="app-provider"
    >
      <div
        className={`app-shell ${presenting ? "presentation-mode" : ""}`}
        data-testid="app"
        data-ready={ready}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault();
        }}
        onDrop={(e) => {
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (file) void importImage(file);
        }}
      >
        <header className="app-header">
          <div className="brand">
            <img src="/app-icon.svg" width="30" height="30" alt="" />
            <span>Light Pen</span>
            <span className="beta-tag">Бета</span>
          </div>
          <div className="header-divider" />
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button
                appearance="subtle"
                className="file-trigger"
                icon={<ChevronDown16Regular />}
                iconPosition="after"
                aria-label="Меню файла"
              >
                Файл
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                <MenuItem
                  icon={<DocumentAdd20Regular />}
                  onClick={() => void newBoard()}
                  secondaryContent="Ctrl+N"
                >
                  Новая доска
                </MenuItem>
                <MenuItem
                  icon={<FolderOpen20Regular />}
                  onClick={() => void openBoard()}
                  secondaryContent="Ctrl+O"
                >
                  Открыть…
                </MenuItem>
                <MenuItem onClick={() => void showRecents()}>
                  Недавние доски…
                </MenuItem>
                <MenuDivider />
                <MenuItem
                  icon={<Save20Regular />}
                  onClick={() => void saveBoard()}
                  secondaryContent="Ctrl+S"
                >
                  Сохранить
                </MenuItem>
                <MenuItem
                  onClick={() => void saveBoard(true)}
                  secondaryContent="Ctrl+Shift+S"
                >
                  Сохранить как…
                </MenuItem>
                <MenuDivider />
                <MenuItem
                  icon={<Image20Regular />}
                  onClick={() => importInput.current?.click()}
                >
                  Добавить изображение…
                </MenuItem>
                <MenuItem
                  icon={<ArrowDownload20Regular />}
                  onClick={() => void exportBoard()}
                >
                  Экспортировать PNG…
                </MenuItem>
                <MenuDivider />
                <MenuItem onClick={() => void loadExample()}>
                  Открыть пример
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    editor.grid = !editor.grid;
                    editor.emit("scene");
                  }}
                >
                  {editor.grid ? "Скрыть" : "Показать"} сетку
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
          <div className="document-info">
            <input
              className="document-title"
              aria-label="Название доски"
              maxLength={250}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={(e) => editor.rename(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  e.currentTarget.value = editor.document.title;
                  setTitle(editor.document.title);
                  e.currentTarget.blur();
                }
              }}
            />
            <Tooltip
              content={saver.path ?? "Автосохранение на этом устройстве"}
              relationship="description"
            >
              <span
                className={`save-status ${saver.status}`}
                role="status"
                data-testid="save-status"
              >
                {saver.status === "saved" ? (
                  <CheckmarkCircle16Regular />
                ) : saver.status === "saving" ? (
                  <Spinner size="extra-tiny" />
                ) : (
                  <span className="status-dot" />
                )}
                {status}
              </span>
            </Tooltip>
          </div>
          <div className="header-actions">
            <Tooltip content="Отменить · Ctrl+Z" relationship="label">
              <Button
                appearance="subtle"
                icon={<ArrowUndo20Regular />}
                aria-label="Отменить"
                disabled={!editor.history.canUndo || !!editor.replay}
                onClick={() => editor.undo()}
              />
            </Tooltip>
            <Tooltip content="Повторить · Ctrl+Shift+Z" relationship="label">
              <Button
                appearance="subtle"
                icon={<ArrowRedo20Regular />}
                aria-label="Повторить"
                disabled={!editor.history.canRedo || !!editor.replay}
                onClick={() => editor.redo()}
              />
            </Tooltip>
            <div className="header-divider" />
            <Tooltip
              content={
                editor.replay
                  ? "Выйти из воспроизведения"
                  : "Воспроизвести доску"
              }
              relationship="label"
            >
              <Button
                appearance={editor.replay ? "primary" : "subtle"}
                icon={editor.replay ? <Stop20Regular /> : <Play20Regular />}
                aria-label={
                  editor.replay
                    ? "Остановить воспроизведение"
                    : "Воспроизвести доску"
                }
                disabled={!editor.elements.length}
                onClick={() =>
                  editor.replay ? editor.stopReplay() : editor.startReplay()
                }
              />
            </Tooltip>
            <Tooltip
              content={dark ? "Светлая тема" : "Тёмная тема"}
              relationship="label"
            >
              <Button
                appearance="subtle"
                icon={
                  dark ? <WeatherSunny20Regular /> : <WeatherMoon20Regular />
                }
                aria-label="Переключить тему"
                onClick={() => setDark(!dark)}
              />
            </Tooltip>
            <Tooltip content="Помощь · F1" relationship="label">
              <Button
                appearance="subtle"
                className="help-header"
                icon={<QuestionCircle20Regular />}
                aria-label="Помощь"
                onClick={() => setHelp(true)}
              />
            </Tooltip>
            <Button
              appearance="primary"
              icon={<Save20Regular />}
              onClick={() => void saveBoard()}
              disabled={busy}
              className="save-button"
            >
              Сохранить
            </Button>
          </div>
        </header>
        <main className="workspace">
          <CanvasView editor={editor} dark={dark} onRenderer={rendererReady} />
          <BoardFeatures
            editor={editor}
            flush={() => saver.flush()}
            onExportFrame={(id) => void exportBoard(id)}
            onPresent={() => setPresenting(true)}
            notify={notify}
            onError={setError}
            disabled={busy || !ready}
          />
          <Studio
            editor={editor}
            onExport={() => setExportOpen(true)}
            onPresent={() => setPresenting(true)}
            notify={notify}
            onError={setError}
          />
          <Minimap editor={editor} />
          {presenting && editor.slides.length > 0 && (
            <Presentation
              key={editor.document.id}
              editor={editor}
              onClose={() => setPresenting(false)}
            />
          )}
          <nav
            className="tool-rail floating"
            aria-label="Инструменты"
            data-testid="toolbar"
          >
            {TOOLS.filter((t) =>
              [
                "select",
                "hand",
                "pen",
                "highlighter",
                "eraser",
                "rectangle",
                "text",
                "sticky",
                "connector",
              ].includes(t.tool),
            ).map(({ tool, name, key }, i) => (
              <div key={tool}>
                {(i === 2 || i === 5 || i === 10) && (
                  <div className="rail-divider" />
                )}
                <Tooltip content={`${name} · ${key}`} relationship="label">
                  <Button
                    appearance="subtle"
                    className={`tool-button ${editor.tool === tool ? "active" : ""}`}
                    icon={<ToolIcon tool={tool} />}
                    aria-label={`${name} (${key})`}
                    aria-pressed={editor.tool === tool}
                    disabled={!!editor.replay || busy}
                    onClick={() => editor.setTool(tool)}
                  />
                </Tooltip>
              </div>
            ))}
            <Button
              appearance="subtle"
              className="tool-button"
              aria-label="Другие инструменты"
              onClick={() => editor.setDock("insert")}
            >
              …
            </Button>
          </nav>
          <PropertyDock editor={editor} />
          <div className="board-meta floating">
            <span className="local-dot" />
            {editor.selected.size
              ? `Выбрано: ${editor.selected.size}`
              : `Объектов: ${editor.elements.length}`}
            <span className="meta-separator" />
            <span className="meta-caption">На этом устройстве</span>
          </div>
          <div className="zoom-controls floating">
            <Tooltip content="Уменьшить" relationship="label">
              <Button
                appearance="subtle"
                icon={<ZoomOut20Regular />}
                aria-label="Уменьшить"
                onClick={() => editor.zoom(1 / 1.2)}
              />
            </Tooltip>
            <button
              className="zoom-value"
              aria-label="Масштаб 100%"
              onClick={() => editor.zoom(1 / editor.camera.zoom)}
            >
              {Math.round(editor.camera.zoom * 100)}%
            </button>
            <Tooltip content="Увеличить" relationship="label">
              <Button
                appearance="subtle"
                icon={<ZoomIn20Regular />}
                aria-label="Увеличить"
                onClick={() => editor.zoom(1.2)}
              />
            </Tooltip>
            <div className="zoom-divider" />
            <Tooltip
              content="Показать всю доску · Shift+1"
              relationship="label"
            >
              <Button
                appearance="subtle"
                icon={<FullScreenMaximize20Regular />}
                aria-label="Показать всю доску"
                onClick={() => editor.fit()}
              />
            </Tooltip>
          </div>
          {editor.replay && (
            <div
              className="replay-controls floating"
              aria-label="Воспроизведение"
            >
              <Button
                appearance="subtle"
                icon={
                  editor.replay.playing ? <Pause20Regular /> : <Play20Regular />
                }
                aria-label={editor.replay.playing ? "Пауза" : "Продолжить"}
                onClick={() => editor.toggleReplay()}
              />
              <Slider
                min={0}
                max={1000}
                value={Math.round(editor.replay.progress * 1000)}
                aria-label="Позиция воспроизведения"
                onChange={(_, data) => editor.seekReplay(data.value / 1000)}
              />
              <button
                className="speed-button"
                onClick={() =>
                  editor.speedReplay(
                    editor.replay!.speed >= 4 ? 0.5 : editor.replay!.speed * 2,
                  )
                }
              >
                {editor.replay.speed}×
              </button>
              <Button
                appearance="subtle"
                icon={<Dismiss20Regular />}
                aria-label="Закрыть воспроизведение"
                onClick={() => editor.stopReplay()}
              />
            </div>
          )}
          {message && (
            <div className="toast floating" role="status">
              {message}
            </div>
          )}
          {currentError && (
            <div className="error-banner floating" role="alert">
              <div>
                <strong>Не удалось выполнить действие</strong>
                <p>{currentError}</p>
              </div>
              {saver.status === "error" && (
                <Button
                  size="small"
                  onClick={() => {
                    setDismissedError("");
                    void action(() => saver.flush());
                  }}
                >
                  Повторить
                </Button>
              )}
              <Button
                appearance="subtle"
                icon={<Dismiss20Regular />}
                aria-label="Закрыть сообщение"
                onClick={() => {
                  setError("");
                  setDismissedError(rawError);
                }}
              />
            </div>
          )}
          {(!ready || (busy && !waitingForFile)) && (
            <div className="busy-overlay">
              <Spinner label={ready ? "Подождите…" : "Открываем доску…"} />
            </div>
          )}
        </main>
        {exportOpen && (
          <ExportDialog
            hasSelection={editor.selected.size > 0}
            hasFrames={editor.slides.length > 0}
            busy={busy}
            onClose={() => setExportOpen(false)}
            onExport={exportDocument}
          />
        )}
        <input
          ref={importInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden-input"
          data-testid="image-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) void importImage(file);
          }}
        />
        <Dialog open={help} onOpenChange={(_, data) => setHelp(data.open)}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Удобно с первых линий</DialogTitle>
              <DialogContent>
                <p className="help-intro">
                  Всё, что вы создаёте, остаётся на этом устройстве. Черновик
                  сохраняется автоматически; кнопка «Сохранить» создаёт
                  отдельный файл доски.
                </p>
                <div className="shortcut-grid">
                  {[
                    ["P / M / E", "Перо / маркер / ластик"],
                    ["V / H", "Выделение / рука"],
                    ["R / O / D", "Прямоугольник / эллипс / ромб"],
                    ["A / L / T / N", "Стрелка / линия / текст / стикер"],
                    ["C / F / Q", "Соединитель / фрейм / формула LaTeX"],
                    ["Ctrl + F", "Поиск по доске"],
                    ["Ctrl + G / Shift + G", "Группа / разгруппировать"],
                    ["Space + мышь", "Перемещение доски"],
                    ["Колесо мыши", "Масштаб к указателю"],
                    ["Shift + рисование", "Ровная фигура / угол 45°"],
                    ["Shift + щелчок", "Добавить в выделение"],
                    ["Ctrl + Z / Shift + Z", "Отменить / повторить"],
                    ["Ctrl + D / C / V", "Дублировать / копировать / вставить"],
                    ["Ctrl + S / O / N", "Сохранить / открыть / новая доска"],
                    ["Shift + 1 / 2", "Вся доска / выделение"],
                    ["Ctrl + Enter", "Завершить ввод текста"],
                    ["Escape", "Отменить жест / снять выделение"],
                  ].map(([key, description]) => (
                    <div key={key}>
                      <kbd>{key}</kbd>
                      <span>{description}</span>
                    </div>
                  ))}
                </div>
                <p className="help-footnote">
                  Двойной щелчок редактирует текст и стикеры. Ластик удаляет
                  объект целиком. При выделении PNG экспортируется только для
                  выбранных объектов. Изображения можно перетащить на доску или
                  вставить через Ctrl+V. Правая кнопка мыши открывает действия с
                  объектом. Настройки пера и история версий находятся справа над
                  доской.
                </p>
              </DialogContent>
              <DialogActions>
                <Button appearance="primary" onClick={() => setHelp(false)}>
                  Понятно
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
        <Dialog open={closeError}>
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Доска ещё не сохранена</DialogTitle>
              <DialogContent>
                Не удалось записать последние изменения. Вернитесь к доске и
                сохраните её в другую папку, чтобы не потерять работу.
              </DialogContent>
              <DialogActions>
                <Button
                  onClick={() => {
                    setCloseError(false);
                  }}
                >
                  Вернуться к доске
                </Button>
                <Button
                  appearance="primary"
                  onClick={() => {
                    if (native) void getCurrentWindow().destroy();
                  }}
                >
                  Закрыть без сохранения
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
        <Dialog
          open={recentOpen}
          onOpenChange={(_, data) => setRecentOpen(data.open)}
        >
          <DialogSurface>
            <DialogBody>
              <DialogTitle>Недавние доски</DialogTitle>
              <DialogContent>
                <p className="help-intro">
                  Здесь остаются и доски, которые вы ещё не сохранили в
                  отдельный файл.
                </p>
                <div className="recent-list">
                  {recents.length ? (
                    recents.map((item) => (
                      <button
                        className="recent-item"
                        key={item.id}
                        onClick={() => void openRecent(item.id)}
                      >
                        <span className="recent-name">{item.title}</span>
                        <span className="recent-detail">
                          {item.path
                            ? item.path.split(/[\\/]/).at(-1)
                            : "Локальный черновик"}{" "}
                          ·{" "}
                          {new Date(item.updatedAt).toLocaleDateString("ru-RU")}
                        </span>
                      </button>
                    ))
                  ) : (
                    <p>Пока нет сохранённых досок.</p>
                  )}
                </div>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setRecentOpen(false)}>Закрыть</Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      </div>
    </FluentProvider>
  );
}

declare global {
  interface Window {
    __LIGHT_PEN_TEST__?: {
      editor: Editor;
      saver: SaveCoordinator;
      renderer: BoardRenderer | null;
      load?: (doc: BoardDocument) => void;
    };
  }
}
