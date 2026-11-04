import { useEffect, useRef, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from "@fluentui/react-components";
import { Dismiss20Regular } from "@fluentui/react-icons";
import type { Editor } from "../editor/editor";
import type { SceneElement } from "../editor/model/types";
import { validateDocument } from "../editor/model/types";
import {
  buildFragment,
  FRAGMENT_PREFIX,
  fragmentWarnings,
  importFragmentElements,
  MAX_FRAGMENT_BYTES,
  parseFragment,
  validateFragment,
} from "../editor/model/fragments";
import type { PortableFragment } from "../editor/model/fragments";
import { replacePageElements } from "../editor/model/pages";
import { screenToWorld } from "../editor/model/geometry";
import { saveDataText } from "../platform/native";

export function Fragments({
  editor,
  notify,
  onError,
}: {
  editor: Editor;
  notify: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [opened, setOpened] = useState(false),
    [mode, setMode] = useState<"export" | "import">("export"),
    [fragment, setFragment] = useState<PortableFragment | null>(null),
    [checked, setChecked] = useState(new Set<string>()),
    [title, setTitle] = useState("Фрагмент"),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null),
    isOpen = useRef(opened),
    pendingClipboard = useRef<string | null>(null);
  isOpen.current = opened;
  const close = () => {
    if (editor.agentPanel?.kind === "fragments") editor.agentPanel = null;
    isOpen.current = false;
    setOpened(false);
    setError("");
  };
  const show = (
    fragment: PortableFragment,
    mode: "export" | "import",
    agent = false,
  ) => {
    close();
    setFragment(fragment);
    setMode(mode);
    setTitle(fragment.title);
    setChecked(new Set(fragment.elements.map((e) => e.id)));
    setQuery("");
    setPage(0);
    isOpen.current = true;
    setOpened(true);
    if (agent)
      editor.agentPanel = {
        kind: "fragments",
        close,
        isOpen: () => isOpen.current,
      };
  };
  const run = async (action: () => Promise<void>) => {
    if (working) return;
    setWorking(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(false);
    }
  };

  useEffect(() => {
    const read = async (a: Record<string, any>) =>
      buildFragment(editor.document, a.ids ?? [...editor.selected], {
        pageId: editor.activePageId,
        includeFrameContents: a.includeFrameContents ?? true,
        title: a.title,
      });
    const insert = async (a: Record<string, any>) => {
      a.assert?.();
      if (editor.readOnly) throw Error("У вас доступ только для просмотра.");
      if (
        !editor.enabled ||
        editor.isInteracting ||
        editor.presenting ||
        editor.replay
      )
        throw Error("Завершите текущий ввод перед вставкой фрагмента.");
      const before = editor.document,
        pageId = editor.activePageId;
      const fragment =
        typeof a.text === "string"
          ? parseFragment(a.text)
          : validateFragment(a.fragment);
      const imported = importFragmentElements(fragment, {
        pageId,
        at:
          a.at ??
          screenToWorld(
            { x: editor.viewport.width * 0.57, y: editor.viewport.height / 2 },
            editor.camera,
          ),
        slideOrderStart: editor.slides.length,
      });
      const current = [...editor.elements, ...imported.elements];
      validateDocument({
        ...before,
        schemaVersion: 5,
        pages: editor.pages,
        elements: replacePageElements(before, pageId, current),
      });
      const assets = imported.elements.filter(
        (e) => e.kind === "image" || e.kind === "math",
      );
      if (assets.length)
        await editor.services.get("validate_assets")?.({ elements: assets });
      if (editor.document !== before || editor.activePageId !== pageId)
        throw Error("Доска изменилась во время подготовки. Повторите вставку.");
      if (editor.readOnly || !editor.enabled || editor.isInteracting)
        throw Error("Доступ изменился во время подготовки. Повторите вставку.");
      a.assert?.();
      editor.commit(current, "Вставка фрагмента");
      if (
        !imported.elements.every((e) =>
          editor.elements.some((x) => x.id === e.id),
        )
      )
        throw Error("Не удалось вставить фрагмент в текущую группу.");
      editor.selected = new Set(imported.elements.map((e) => e.id));
      editor.tool = "select";
      editor.emit("ui");
      editor.emit("overlay");
      return { created: [...editor.selected], warnings: imported.warnings };
    };
    const copy = async () => {
      const fragment = await read({});
      const text = FRAGMENT_PREFIX + JSON.stringify(fragment);
      // Preserve an internal fallback when the OS clipboard is unavailable.
      editor.copy();
      pendingClipboard.current = text;
      let systemClipboard = true;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        systemClipboard = false;
      }
      return {
        objects: fragment.elements.length,
        warnings: fragment.warnings,
        systemClipboard,
      };
    };
    const paste = async (a: Record<string, any>) => {
      let text = a.text;
      if (typeof text !== "string") {
        try {
          text = await navigator.clipboard.readText();
        } catch {
          if (!pendingClipboard.current)
            throw Error("Не удалось прочитать системный буфер.");
          text = pendingClipboard.current;
        }
      }
      if (!text.startsWith(FRAGMENT_PREFIX)) return { handled: false };
      const result = await insert({ text, at: a.at });
      return { handled: true, ...result };
    };
    const ui = async (a: Record<string, any>) => {
      if (a.action === "import") {
        input.current?.click();
        return { choosingFile: true };
      }
      if (a.action === "clipboard") {
        const text = await navigator.clipboard.readText();
        show(parseFragment(text), "import", !!a.agent);
      } else if (a.action === "open" || !a.action) {
        editor.commitText();
        editor.endStyle();
        editor.cancelGesture();
        show(await read(a), "export", !!a.agent);
      } else throw Error("Неизвестное действие фрагмента.");
      return { panel: "fragments" };
    };
    const copyEvent = (event: ClipboardEvent) => {
      if (
        document.querySelector('[role="dialog"]') ||
        editor.isInteracting ||
        editor.replay ||
        editor.presenting ||
        (event.target instanceof Element &&
          event.target.closest("input,textarea,[contenteditable=true]"))
      )
        return;
      if (!editor.selected.size) return;
      try {
        const fragment = buildFragment(editor.document, [...editor.selected], {
          pageId: editor.activePageId,
        });
        const text = FRAGMENT_PREFIX + JSON.stringify(fragment);
        event.clipboardData?.setData("text/plain", text);
        event.preventDefault();
        editor.copy();
        pendingClipboard.current = text;
      } catch (error) {
        onError(error instanceof Error ? error.message : String(error));
      }
    };
    const pasteEvent = (event: ClipboardEvent) => {
      if (
        document.querySelector('[role="dialog"]') ||
        editor.isInteracting ||
        editor.replay ||
        editor.presenting ||
        (event.target instanceof Element &&
          event.target.closest("input,textarea,[contenteditable=true]"))
      )
        return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!text.startsWith(FRAGMENT_PREFIX)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void insert({ text }).catch((error) =>
        onError(error instanceof Error ? error.message : String(error)),
      );
    };
    const handlers = {
      fragment_read: read,
      fragment_import: insert,
      fragment_copy: copy,
      fragment_paste: paste,
      fragment_ui: ui,
    };
    for (const [name, handler] of Object.entries(handlers))
      editor.services.set(name, handler);
    window.addEventListener("copy", copyEvent, true);
    window.addEventListener("paste", pasteEvent, true);
    return () => {
      for (const [name, handler] of Object.entries(handlers))
        if (editor.services.get(name) === handler) editor.services.delete(name);
      window.removeEventListener("copy", copyEvent, true);
      window.removeEventListener("paste", pasteEvent, true);
      if (editor.agentPanel?.kind === "fragments") editor.agentPanel = null;
    };
  }, [editor, onError]);

  const chosen = fragment?.elements.filter((e) => checked.has(e.id)) ?? [];
  const warnings = fragment
    ? fragmentWarnings(chosen, fragment.source.pageId)
    : [];
  const filtered =
    fragment?.elements.filter((e) =>
      `${e.name ?? ""} ${e.text ?? ""} ${e.kind}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
    ) ?? [];
  const pages = Math.max(1, Math.ceil(filtered.length / 100));
  const selectedFragment = () =>
    validateFragment({
      ...fragment,
      title: title.trim() || "Фрагмент",
      elements: chosen,
      warnings,
    });
  return (
    <>
      <input
        ref={input}
        type="file"
        hidden
        accept=".lightpen-fragment,application/json"
        aria-label="Файл фрагмента"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          void (async () => {
            if (file.size > MAX_FRAGMENT_BYTES)
              throw Error("Фрагмент превышает 64 МБ.");
            const fragment = parseFragment(await file.text());
            show(fragment, "import");
          })().catch((error) =>
            onError(error instanceof Error ? error.message : String(error)),
          );
        }}
      />
      <Dialog
        open={opened}
        onOpenChange={(_, data) => {
          if (!data.open && !working) close();
        }}
      >
        <DialogSurface style={{ maxWidth: 620 }}>
          <DialogBody>
            <DialogTitle
              action={
                <Button
                  aria-label="Закрыть фрагмент"
                  appearance="subtle"
                  icon={<Dismiss20Regular />}
                  disabled={working}
                  onClick={close}
                />
              }
            >
              {mode === "export" ? "Перенести фрагмент" : "Вставить фрагмент"}
            </DialogTitle>
            <DialogContent>
              <p className="panel-hint">
                {mode === "export"
                  ? "Фреймы включают своё содержимое. Проверьте состав: изображения, формулы и данные переносятся вместе с объектами."
                  : "Объекты появятся на текущей странице одной операцией. Исходный файл сохранится."}
              </p>
              <label className="field-label">
                Название
                <input
                  aria-label="Название фрагмента"
                  maxLength={250}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <div className="panel-inline-actions">
                <span>
                  {checked.size} из {fragment?.elements.length ?? 0} объектов
                </span>
                <Button
                  size="small"
                  appearance="subtle"
                  onClick={() =>
                    setChecked(new Set(fragment?.elements.map((e) => e.id)))
                  }
                >
                  Выбрать все
                </Button>
                <Button
                  size="small"
                  appearance="subtle"
                  onClick={() => setChecked(new Set())}
                >
                  Снять выбор
                </Button>
              </div>
              <input
                className="search-field"
                aria-label="Поиск в составе фрагмента"
                placeholder="Найти объект"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
              />
              <div
                style={{
                  maxHeight: "min(32vh, 280px)",
                  overflowY: "auto",
                  marginTop: 8,
                }}
              >
                {filtered
                  .slice(page * 100, (page + 1) * 100)
                  .map((e: SceneElement) => (
                    <div key={e.id}>
                      <Checkbox
                        checked={checked.has(e.id)}
                        label={`${e.name || e.text?.slice(0, 80) || objectName(e)}${e.hidden ? " (скрыт)" : ""}`}
                        onChange={(_, data) =>
                          setChecked((previous) => {
                            const next = new Set(previous);
                            data.checked ? next.add(e.id) : next.delete(e.id);
                            return next;
                          })
                        }
                      />
                    </div>
                  ))}
              </div>
              {pages > 1 && (
                <div className="panel-inline-actions">
                  <Button
                    size="small"
                    disabled={!page}
                    onClick={() => setPage(page - 1)}
                  >
                    Назад
                  </Button>
                  <span>
                    {page + 1} / {pages}
                  </span>
                  <Button
                    size="small"
                    disabled={page + 1 >= pages}
                    onClick={() => setPage(page + 1)}
                  >
                    Далее
                  </Button>
                </div>
              )}
              {warnings.length > 0 && (
                <details style={{ marginTop: 12 }}>
                  <summary>Проверьте связи: {warnings.length}</summary>
                  <ul className="panel-hint">
                    {warnings.slice(0, 20).map((warning, i) => (
                      <li key={i}>{warning.message}</li>
                    ))}
                  </ul>
                  {warnings.length > 20 && (
                    <p className="panel-hint">
                      И ещё {warnings.length - 20} связей вне фрагмента.
                    </p>
                  )}
                </details>
              )}
              {error && (
                <p role="alert" className="inline-error">
                  {error}
                </p>
              )}
            </DialogContent>
            <DialogActions>
              <Button disabled={working} onClick={close}>
                Закрыть
              </Button>
              {mode === "export" && (
                <Button
                  disabled={working || !chosen.length}
                  onClick={() =>
                    void run(async () => {
                      await navigator.clipboard.writeText(
                        FRAGMENT_PREFIX + JSON.stringify(selectedFragment()),
                      );
                      notify(
                        "Фрагмент скопирован. Вставьте его на другой странице или в другой доске.",
                      );
                    })
                  }
                >
                  В буфер
                </Button>
              )}
              <Button
                appearance="primary"
                disabled={
                  working ||
                  !chosen.length ||
                  (mode === "import" && editor.readOnly)
                }
                onClick={() =>
                  void run(async () => {
                    const fragment = selectedFragment();
                    if (mode === "export") {
                      if (
                        await saveDataText(
                          JSON.stringify(fragment),
                          fragment.title,
                          "lightpen-fragment",
                        )
                      )
                        notify("Фрагмент сохранён");
                    } else {
                      await editor.services.get("fragment_import")!({
                        fragment,
                      });
                      close();
                      notify("Фрагмент вставлен. Действие можно отменить.");
                    }
                  })
                }
              >
                {working
                  ? "Подготовка…"
                  : mode === "export"
                    ? "Сохранить файл…"
                    : "Вставить"}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}

function objectName(element: SceneElement) {
  return (
    (
      {
        stroke: "Штрих",
        rectangle: "Прямоугольник",
        ellipse: "Эллипс",
        diamond: "Ромб",
        arrow: "Стрелка",
        line: "Линия",
        text: "Текст",
        sticky: "Стикер",
        image: "Изображение",
        frame: "Фрейм",
        math: "Формула",
        table: "Таблица",
        task: "Задача",
        link: "Ссылка",
      } as Record<string, string>
    )[element.kind] ?? "Объект"
  );
}
