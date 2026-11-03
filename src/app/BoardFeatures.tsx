import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Slider,
  Tooltip,
} from "@fluentui/react-components";
import {
  Search20Regular,
  History20Regular,
  Settings20Regular,
  Board20Regular,
  Dismiss20Regular,
} from "@fluentui/react-icons";
import type { Editor } from "../editor/editor";
import type { InkOptions } from "../editor/model/types";
import { checkpoint, readVersion, versions } from "../platform/native";
import type { DocumentVersion } from "../platform/native";
import { getStroke } from "perfect-freehand";
import { keyboardCode } from "../platform/keyboard";

export function BoardFeatures({
  editor,
  flush,
  onExportFrame,
  onPresent,
  notify,
  onError,
  disabled,
}: {
  editor: Editor;
  flush: () => Promise<void>;
  onExportFrame: (id: string) => void;
  onPresent: () => void;
  notify: (s: string) => void;
  onError: (s: string) => void;
  disabled: boolean;
}) {
  const panel =
    editor.dock === "search" || editor.dock === "frames" ? editor.dock : null;
  const setPanel = (value: typeof panel) => {
    editor.dock = value;
    editor.emit("ui");
  };
  const [query, setQuery] = useState("");
  const [settings, setSettings] = useState(false),
    [history, setHistory] = useState(false),
    [snapshots, setSnapshots] = useState<DocumentVersion[]>([]),
    [working, setWorking] = useState(false),
    [restore, setRestore] = useState<DocumentVersion | null>(null);
  const context = useRef<HTMLDivElement>(null),
    search = useRef<HTMLInputElement>(null);
  const documentId = editor.document.id;
  const results = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return q
      ? editor.elements
          .filter((e) =>
            `${e.name ?? ""} ${e.text ?? ""} ${e.label ?? ""} ${e.cells?.flat().join(" ") ?? ""} ${e.task?.description ?? ""} ${e.task?.tags?.join(" ") ?? ""} ${e.task?.items.map((i) => i.text).join(" ") ?? ""}`
              .toLocaleLowerCase()
              .includes(q),
          )
          .slice(0, 100)
      : [];
  }, [query, editor.document]);
  const frames = editor.slides;
  useEffect(() => {
    try {
      const eraser = Number(localStorage.getItem("lightpen.eraserSize")),
        marker = Number(localStorage.getItem("lightpen.markerSize"));
      if (eraser >= 4 && eraser <= 160) editor.eraserSize = eraser;
      if (marker >= 1 && marker <= 128) editor.markerSize = marker;
      const value = JSON.parse(localStorage.getItem("lightpen.pen") ?? "null");
      if (
        value &&
        ["smoothing", "stabilization", "minWidth", "pressure"].every(
          (k) => typeof value[k] === "number" && Number.isFinite(value[k]),
        )
      ) {
        editor.pen = {
          smoothing: Math.max(0, Math.min(100, value.smoothing)),
          stabilization: Math.max(0, Math.min(95, value.stabilization)),
          minWidth: Math.max(1, Math.min(100, value.minWidth)),
          pressure: Math.max(25, Math.min(200, value.pressure)),
        };
      }
    } catch {}
    const key = (e: KeyboardEvent) => {
      const code = keyboardCode(e);
      if (
        disabled ||
        editor.presenting ||
        document.querySelector('[role="dialog"]')
      )
        return;
      if ((e.ctrlKey || e.metaKey) && code === "KeyF") {
        e.preventDefault();
        setPanel("search");
        return;
      }
      if (
        (e.target as HTMLElement)?.closest(
          "input,textarea,[contenteditable=true]",
        )
      )
        return;
      if ((e.ctrlKey || e.metaKey) && code === "KeyG") {
        e.preventDefault();
        e.shiftKey ? editor.ungroup() : editor.group();
      }
      if (e.key === "Escape") {
        setPanel(null);
        editor.contextMenu = null;
        editor.emit("ui");
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [editor, disabled]);
  useEffect(() => {
    if (panel === "search") search.current?.focus();
  }, [panel]);
  useEffect(() => {
    setRestore(null);
    setHistory(false);
    setSnapshots([]);
  }, [documentId]);
  useEffect(() => {
    if (!editor.contextMenu) return;
    context.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const dismiss = (e: PointerEvent) => {
      if (!context.current?.contains(e.target as Node)) {
        editor.contextMenu = null;
        editor.emit("ui");
      }
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [editor, editor.contextMenu]);
  const run = async (fn: () => Promise<void>) => {
    if (working) return;
    setWorking(true);
    try {
      editor.endStyle();
      editor.commitText();
      editor.cancelGesture();
      await flush();
      await fn();
    } catch (e) {
      onError(String(e instanceof Error ? e.message : e));
    } finally {
      setWorking(false);
    }
  };
  const showHistory = () =>
    void run(async () => {
      setSnapshots(await versions(editor.document.id));
      setHistory(true);
    });
  const saveSnapshot = () =>
    void run(async () => {
      await checkpoint(editor.document);
      setSnapshots(await versions(editor.document.id));
      notify("Снимок доски сохранён");
    });
  const restoreSnapshot = () =>
    void run(async () => {
      if (!restore) return;
      const old = await readVersion(editor.document.id, restore.id);
      await checkpoint(editor.document);
      editor.commit(old.elements, "Восстановление версии", old.title);
      await flush();
      setRestore(null);
      setHistory(false);
      notify("Версия восстановлена. Предыдущее состояние осталось в истории");
    });
  const updatePen = (key: keyof InkOptions, value: number) => {
    editor.pen = { ...editor.pen, [key]: value };
    localStorage.setItem("lightpen.pen", JSON.stringify(editor.pen));
    editor.emit("ui");
  };
  const action = (fn: () => void) => {
    editor.contextMenu = null;
    fn();
    editor.emit("ui");
    editor.emit("overlay");
  };
  const at = editor.contextMenu;
  return (
    <>
      <div
        className="board-utilities floating"
        aria-label="Навигация и настройки"
      >
        <Tooltip content="Поиск · Ctrl+F" relationship="label">
          <Button
            appearance="subtle"
            icon={<Search20Regular />}
            aria-label="Поиск по доске"
            disabled={disabled || !!editor.replay}
            onClick={() => setPanel(panel === "search" ? null : "search")}
          />
        </Tooltip>
        <Tooltip content="Фреймы" relationship="label">
          <Button
            appearance="subtle"
            icon={<Board20Regular />}
            aria-label="Фреймы доски"
            disabled={disabled}
            onClick={() => setPanel(panel === "frames" ? null : "frames")}
          />
        </Tooltip>
        <Tooltip content="История версий" relationship="label">
          <Button
            appearance="subtle"
            icon={<History20Regular />}
            aria-label="История версий"
            disabled={disabled || working || !!editor.replay}
            onClick={showHistory}
          />
        </Tooltip>
        <Tooltip content="Настройки пера" relationship="label">
          <Button
            appearance="subtle"
            icon={<Settings20Regular />}
            aria-label="Настройки пера"
            disabled={disabled}
            onClick={() => setSettings(true)}
          />
        </Tooltip>
      </div>
      {panel && (
        <aside
          className="navigation-panel floating"
          aria-label={panel === "search" ? "Поиск по доске" : "Фреймы"}
        >
          <div className="panel-title">
            <strong>{panel === "search" ? "Найти на доске" : "Фреймы"}</strong>
            <Button
              size="small"
              appearance="subtle"
              icon={<Dismiss20Regular />}
              aria-label="Закрыть панель"
              onClick={() => setPanel(null)}
            />
          </div>
          {panel === "search" ? (
            <>
              <input
                ref={search}
                className="search-field"
                aria-label="Поисковый запрос"
                placeholder="Текст заметки или формула"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && results[0])
                    editor.focusElement(results[0].id);
                }}
              />
              <p className="panel-hint">
                {query.trim()
                  ? results.length
                    ? `Найдено: ${results.length}${results.length === 100 ? "+" : ""}`
                    : "Ничего не найдено"
                  : "Ищите в тексте, стикерах, названиях фреймов и формулах."}
              </p>
              <div className="navigation-list">
                {results.map((e) => (
                  <button
                    key={e.id}
                    className="navigation-item"
                    onClick={() => editor.focusElement(e.id)}
                  >
                    <span>{e.text?.slice(0, 160)}</span>
                    <small>
                      {e.kind === "sticky"
                        ? "Стикер"
                        : e.kind === "math"
                          ? "Формула"
                          : e.kind === "frame"
                            ? "Фрейм"
                            : "Текст"}
                      {e.locked ? " · закреплён" : ""}
                    </small>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <Button
                appearance="primary"
                onClick={() => {
                  editor.setTool("frame");
                  setPanel(null);
                }}
              >
                Нарисовать фрейм
              </Button>
              {!!frames.length && (
                <Button onClick={onPresent}>Начать презентацию</Button>
              )}
              {!frames.length && (
                <p className="panel-hint">
                  Обведите область инструментом «Фрейм». Её можно назвать,
                  переместить вместе с содержимым и экспортировать.
                </p>
              )}
              <div className="navigation-list">
                {frames.map((e) => (
                  <div className="frame-item" key={e.id}>
                    <div className="layer-arrows">
                      <button
                        aria-label={`Слайд выше ${e.text}`}
                        onClick={() => editor.reorderSlide(e.id, -1)}
                      >
                        ↑
                      </button>
                      <button
                        aria-label={`Слайд ниже ${e.text}`}
                        onClick={() => editor.reorderSlide(e.id, 1)}
                      >
                        ↓
                      </button>
                    </div>
                    <button
                      className="navigation-item"
                      onClick={() => editor.focusElement(e.id)}
                    >
                      <span>{e.text || "Фрейм"}</span>
                      <small>
                        {Math.round(e.width)} × {Math.round(e.height)}
                      </small>
                    </button>
                    <Button
                      size="small"
                      appearance="subtle"
                      aria-label={`Экспорт фрейма ${e.text}`}
                      onClick={() => onExportFrame(e.id)}
                    >
                      PNG
                    </Button>
                  </div>
                ))}
              </div>
            </>
          )}
        </aside>
      )}
      {editor.selected.size > 0 && !editor.replay && (
        <div
          className="selection-tools floating"
          aria-label="Операции с выделением"
        >
          <Button
            size="small"
            appearance="subtle"
            disabled={disabled || editor.selection.length < 2}
            onClick={() => editor.group()}
          >
            Группа
          </Button>
          {editor.canEnterGroup && (
            <Button
              size="small"
              appearance="subtle"
              onClick={() => editor.enterGroup()}
            >
              Войти в группу
            </Button>
          )}
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <Button size="small" appearance="subtle" disabled={disabled}>
                Выровнять
              </Button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {(
                  [
                    ["left", "По левому краю"],
                    ["center", "По центру по горизонтали"],
                    ["right", "По правому краю"],
                    ["top", "По верхнему краю"],
                    ["middle", "По центру по вертикали"],
                    ["bottom", "По нижнему краю"],
                    ["horizontal", "Равные интервалы по горизонтали"],
                    ["vertical", "Равные интервалы по вертикали"],
                  ] as const
                ).map(([mode, label]) => (
                  <MenuItem key={mode} onClick={() => editor.align(mode)}>
                    {label}
                  </MenuItem>
                ))}
              </MenuList>
            </MenuPopover>
          </Menu>
          <Button
            size="small"
            appearance="subtle"
            disabled={disabled}
            onClick={() =>
              editor.lockSelection(!editor.selection.every((e) => e.locked))
            }
          >
            {editor.selection.every((e) => e.locked)
              ? "Разблокировать"
              : "Закрепить"}
          </Button>
        </div>
      )}
      {!!editor.groupScope.length && (
        <div className="group-scope floating" aria-label="Путь группы">
          <Button
            size="small"
            onClick={() => {
              editor.groupScope = [];
              editor.selected.clear();
              editor.emit("ui");
              editor.emit("overlay");
            }}
          >
            Вся доска
          </Button>
          {editor.groupScope.map((id, i) => (
            <Button
              size="small"
              key={id}
              onClick={() => {
                editor.groupScope = editor.groupScope.slice(0, i + 1);
                editor.selected.clear();
                editor.emit("ui");
                editor.emit("overlay");
              }}
            >
              Группа {i + 1}
            </Button>
          ))}
          <Button size="small" onClick={() => editor.leaveGroup()}>
            Назад · Esc
          </Button>
        </div>
      )}
      {at && (
        <div
          ref={context}
          role="menu"
          className="board-context floating"
          aria-label="Контекстное меню доски"
          style={{
            left: Math.min(at.x, editor.viewport.width - 228),
            top: Math.min(at.y, editor.viewport.height - 370),
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              action(() => {});
              return;
            }
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const items = [
                ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role="menuitem"]:not(:disabled)',
                ),
              ];
              const i = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              items[
                (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) %
                  items.length
              ]?.focus();
            }
          }}
        >
          <Button
            role="menuitem"
            appearance="subtle"
            onClick={() => action(() => editor.paste())}
          >
            Вставить объекты <kbd>Ctrl+V</kbd>
          </Button>
          {!!editor.selected.size && (
            <>
              <Button
                role="menuitem"
                appearance="subtle"
                onClick={() => action(() => editor.copy())}
              >
                Копировать <kbd>Ctrl+C</kbd>
              </Button>
              <Button
                role="menuitem"
                appearance="subtle"
                onClick={() => action(() => editor.duplicate())}
              >
                Дублировать <kbd>Ctrl+D</kbd>
              </Button>
              <Button
                role="menuitem"
                appearance="subtle"
                onClick={() => action(() => editor.group())}
              >
                Сгруппировать <kbd>Ctrl+G</kbd>
              </Button>
              <Button
                role="menuitem"
                appearance="subtle"
                onClick={() => action(() => editor.ungroup())}
              >
                Разгруппировать
              </Button>
              {editor.selection.some((e) => e.startBinding || e.endBinding) && (
                <Button
                  role="menuitem"
                  appearance="subtle"
                  onClick={() => action(() => editor.detachConnectors())}
                >
                  Отвязать соединитель
                </Button>
              )}
              <Button
                role="menuitem"
                appearance="subtle"
                onClick={() =>
                  action(() =>
                    editor.lockSelection(
                      !editor.selection.every((e) => e.locked),
                    ),
                  )
                }
              >
                {editor.selection.every((e) => e.locked)
                  ? "Разблокировать"
                  : "Закрепить"}
              </Button>
              <Button
                role="menuitem"
                appearance="subtle"
                onClick={() => action(() => editor.arrange("front"))}
              >
                На передний план
              </Button>
              <Button
                role="menuitem"
                appearance="subtle"
                onClick={() => action(() => editor.arrange("back"))}
              >
                На задний план
              </Button>
              <Button
                role="menuitem"
                appearance="subtle"
                onClick={() => action(() => editor.deleteSelection())}
              >
                Удалить <kbd>Del</kbd>
              </Button>
            </>
          )}
          <Button
            role="menuitem"
            appearance="subtle"
            onClick={() => action(() => editor.unlockAll())}
          >
            Разблокировать всё
          </Button>
          <Button
            role="menuitem"
            appearance="subtle"
            onClick={() =>
              action(() => {
                editor.snap = !editor.snap;
              })
            }
          >
            {editor.snap ? "Отключить" : "Включить"} направляющие
          </Button>
        </div>
      )}
      <Dialog open={settings} onOpenChange={(_, d) => setSettings(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Перо под вашу руку</DialogTitle>
            <DialogContent>
              <p>
                Настройки применяются к новым штрихам. Уже нарисованные линии
                сохраняют свой вид.
              </p>
              <div className="pen-modes">
                <Button
                  appearance={
                    editor.pen.stabilization < 35 ? "primary" : "secondary"
                  }
                  onClick={() => updatePen("stabilization", 12)}
                >
                  Быстрое письмо
                </Button>
                <Button
                  appearance={
                    editor.pen.stabilization >= 35 ? "primary" : "secondary"
                  }
                  onClick={() => updatePen("stabilization", 55)}
                >
                  Аккуратный контур
                </Button>
              </div>
              <PenPreview pen={editor.pen} />
              {(
                [
                  ["smoothing", "Сглаживание", 0, 100],
                  ["stabilization", "Стабилизация", 0, 95],
                  ["minWidth", "Минимальная толщина, %", 1, 100],
                  ["pressure", "Чувствительность к нажиму, %", 25, 200],
                ] as const
              ).map(([key, label, min, max]) => (
                <label className="pen-setting" key={key}>
                  <span>
                    {label}
                    <output>{editor.pen[key]}</output>
                  </span>
                  <Slider
                    min={min}
                    max={max}
                    value={editor.pen[key]}
                    aria-label={label}
                    onChange={(_, d) => updatePen(key, d.value)}
                  />
                </label>
              ))}
              <p className="panel-hint">
                Сильная стабилизация добавляет отставание контура. Для мелкого
                почерка начните с быстрого режима.
              </p>
            </DialogContent>
            <DialogActions>
              <Button
                onClick={() => {
                  editor.pen = {
                    smoothing: 60,
                    stabilization: 12,
                    minWidth: 40,
                    pressure: 100,
                  };
                  localStorage.setItem(
                    "lightpen.pen",
                    JSON.stringify(editor.pen),
                  );
                  editor.emit("ui");
                }}
              >
                Сбросить
              </Button>
              <Button appearance="primary" onClick={() => setSettings(false)}>
                Готово
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog
        open={history}
        onOpenChange={(_, d) => {
          setHistory(d.open);
          setRestore(null);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>История версий</DialogTitle>
            <DialogContent>
              <p>
                До 20 снимков на доску, в пределах 100 МБ. Автоматическая копия
                создаётся при изменениях не чаще раза в минуту.
              </p>
              <Button onClick={saveSnapshot} disabled={working}>
                Создать снимок сейчас
              </Button>
              <div className="version-list">
                {snapshots.map((v) => (
                  <button
                    key={v.id}
                    className={`navigation-item ${restore?.id === v.id ? "chosen" : ""}`}
                    disabled={working}
                    onClick={() => setRestore(v)}
                  >
                    <span>{new Date(v.timestamp).toLocaleString("ru-RU")}</span>
                    <small>
                      {v.manual ? "Снимок вручную" : "Автоматическая копия"} ·{" "}
                      {v.objects} объектов · ревизия {v.revision}
                    </small>
                  </button>
                ))}
              </div>
              {!snapshots.length && (
                <p className="panel-hint">
                  Снимков пока нет. Создайте первый перед большим изменением
                  доски.
                </p>
              )}
              {restore && (
                <p role="status">
                  Выбрана версия от{" "}
                  {new Date(restore.timestamp).toLocaleString("ru-RU")}. Перед
                  восстановлением текущее состояние будет сохранено отдельным
                  снимком.
                </p>
              )}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setHistory(false)}>Закрыть</Button>
              <Button
                appearance="primary"
                disabled={!restore || working}
                onClick={restoreSnapshot}
              >
                Восстановить выбранную
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <FormulaDialog editor={editor} onError={onError} />
    </>
  );
}

function PenPreview({ pen }: { pen: InkOptions }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawn = useRef<number[][]>([]);
  const paint = (samples: number[][]) => {
    const c = ref.current!,
      ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    const points = samples.map(([x, y, p]) => [
      x,
      y,
      Math.pow(p, 100 / pen.pressure),
    ]);
    const outline = getStroke(points, {
      size: 14,
      thinning: 1 - pen.minWidth / 100,
      smoothing: pen.smoothing / 100,
      streamline: pen.stabilization / 100,
      simulatePressure: false,
      last: true,
    });
    ctx.fillStyle = "#0f6cbd";
    ctx.beginPath();
    outline.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
  };
  useEffect(() => {
    paint(
      drawn.current.length
        ? drawn.current
        : Array.from({ length: 200 }, (_, i) => [
            20 + i * 2.5,
            70 + Math.sin(i / 23) * 30,
            0.15 + (0.85 * i) / 199,
          ]),
    );
  }, [pen]);
  return (
    <div className="pen-preview">
      <canvas
        ref={ref}
        width={540}
        height={140}
        aria-label="Предварительный вид штриха"
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const b = e.currentTarget.getBoundingClientRect();
          drawn.current = [
            [
              ((e.clientX - b.left) * 540) / b.width,
              ((e.clientY - b.top) * 140) / b.height,
              e.pointerType === "pen" ? Math.max(0.05, e.pressure) : 0.5,
            ],
          ];
          paint(drawn.current);
        }}
        onPointerMove={(e) => {
          if (
            !e.currentTarget.hasPointerCapture(e.pointerId) ||
            drawn.current.length >= 3000
          )
            return;
          const b = e.currentTarget.getBoundingClientRect();
          drawn.current.push([
            ((e.clientX - b.left) * 540) / b.width,
            ((e.clientY - b.top) * 140) / b.height,
            e.pointerType === "pen" ? Math.max(0.05, e.pressure) : 0.5,
          ]);
          paint(drawn.current);
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
        onPointerCancel={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            e.currentTarget.releasePointerCapture(e.pointerId);
        }}
      />
      <span>Нарисуйте здесь мышью или пером, чтобы проверить настройки</span>
    </div>
  );
}
function FormulaDialog({
  editor,
  onError,
}: {
  editor: Editor;
  onError: (s: string) => void;
}) {
  const draft = editor.formulaDraft;
  const [source, setSource] = useState(""),
    [rendered, setRendered] = useState<{
      dataUrl: string;
      width: number;
      height: number;
    } | null>(null),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  useEffect(() => {
    if (draft) {
      setSource(draft.text ?? "");
      setRendered(null);
      setError("");
    }
  }, [draft?.id]);
  useEffect(() => {
    if (!draft) return;
    let cancelled = false;
    setPending(true);
    setRendered(null);
    setError("");
    const timer = setTimeout(() => {
      void import("../editor/render/math")
        .then(({ renderFormula }) => {
          const result = renderFormula(
            source,
            draft.color,
            draft.fontSize ?? 24,
          );
          if (!cancelled) setRendered(result);
        })
        .catch((e) => {
          if (!cancelled) setError(String(e instanceof Error ? e.message : e));
        })
        .finally(() => {
          if (!cancelled) setPending(false);
        });
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [source, draft?.id]);
  const close = () => {
    editor.formulaDraft = null;
    editor.emit("ui");
  };
  const save = () => {
    if (!rendered || pending) return;
    try {
      editor.saveFormula(source, rendered.width, rendered.height);
    } catch (e) {
      onError(String(e));
    }
  };
  return (
    <Dialog
      open={!!draft}
      onOpenChange={(_, d) => {
        if (!d.open) close();
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Формула LaTeX</DialogTitle>
          <DialogContent>
            <p>
              Введите математическую запись без внешних знаков $. Поддерживаются
              дроби, индексы, суммы, интегралы и матрицы.
            </p>
            <textarea
              className="formula-source"
              aria-label="Исходный LaTeX"
              value={source}
              maxLength={4000}
              onChange={(e) => setSource(e.target.value)}
              placeholder={String.raw`\frac{a}{b} + \sqrt{x^2 + y^2}`}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  save();
                }
              }}
            />
            <div className="formula-examples">
              {[
                String.raw`E=mc^2`,
                String.raw`\frac{-b\pm\sqrt{b^2-4ac}}{2a}`,
                String.raw`\int_0^1 x^2\,dx=\frac{1}{3}`,
                String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
              ].map((s, i) => (
                <Button key={i} size="small" onClick={() => setSource(s)}>
                  {["Степень", "Дробь", "Интеграл", "Матрица"][i]}
                </Button>
              ))}
            </div>
            <div className="formula-preview" aria-label="Предпросмотр формулы">
              {pending ? (
                <span>Подготавливаем формулу…</span>
              ) : rendered ? (
                <img src={rendered.dataUrl} alt={source} />
              ) : (
                <span>{error || "Здесь появится формула"}</span>
              )}
            </div>
            {error && source.trim() && <p role="alert">{error}</p>}
          </DialogContent>
          <DialogActions>
            <Button onClick={close}>Отмена</Button>
            <Button
              appearance="primary"
              disabled={!rendered || pending}
              onClick={save}
            >
              Применить формулу
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
