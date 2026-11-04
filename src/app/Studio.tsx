import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Slider,
  Tooltip,
} from "@fluentui/react-components";
import {
  Add20Regular,
  Layer20Regular,
  Dismiss20Regular,
  Library20Regular,
  ArrowDownload20Regular,
  Presenter20Regular,
} from "@fluentui/react-icons";
import type { Editor } from "../editor/editor";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
  uid,
  COLORS,
  STICKY_COLORS,
} from "../editor/model/types";
import type { SceneElement, Tool } from "../editor/model/types";
import { bounds } from "../editor/model/geometry";
import {
  listTemplates,
  saveTemplate,
  removeTemplate,
  importTemplate,
  exportTemplate,
  readTemplate,
} from "../platform/native";
import type { TemplateSummary } from "../platform/native";
import { StructuredEditor } from "./StructuredEditor";
import { Planning } from "./Planning";
import { ToolIcon } from "./ToolIcon";
import { CustomColor, TextControls } from "./TextControls";
import {
  buildFragment,
  importFragmentElements,
} from "../editor/model/fragments";

export const KIND_NAMES: Record<SceneElement["kind"], string> = {
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
};
export function NumericProperty({
  label,
  value,
  min,
  max,
  onChange,
  onStart,
  onEnd,
  suffix = "",
  disabled = false,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  onStart: () => void;
  onEnd: () => void;
  suffix?: string;
  disabled?: boolean;
}) {
  const [input, setInput] = useState(String(Math.round(value * 10) / 10));
  useEffect(() => setInput(String(Math.round(value * 10) / 10)), [value]);
  const finish = () => {
    const v = Number(input);
    if (input !== "" && Number.isFinite(v)) {
      onStart();
      onChange(Math.max(min, Math.min(max, v)));
    } else setInput(String(value));
    onEnd();
  };
  return (
    <div className="numeric-property">
      <label className="property-label">
        {label}
        <span>{suffix}</span>
      </label>
      <div className="numeric-row">
        <Slider
          aria-label={label}
          min={min}
          max={max}
          value={Math.max(min, Math.min(max, value))}
          disabled={disabled}
          onPointerDown={onStart}
          onChange={(_, d) => {
            onStart();
            onChange(d.value);
          }}
          onPointerUp={onEnd}
          onPointerCancel={onEnd}
          onKeyUp={onEnd}
          onBlur={onEnd}
        />
        <input
          aria-label={`${label} числом`}
          type="number"
          min={min}
          max={max}
          value={input}
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          onBlur={finish}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </div>
    </div>
  );
}
export function ExtraProperties({ editor }: { editor: Editor }) {
  const selection = editor.selection,
    single = selection.length === 1 ? selection[0] : null,
    b = editor.selectionBounds;
  const start = () => editor.beginStyle(),
    end = () => editor.endStyle(),
    disabled = selection.some((e) => e.locked);
  const isConnector = single && ["line", "arrow"].includes(single.kind);
  return (
    <>
      {editor.tool === "eraser" ? (
        <NumericProperty
          label="Размер ластика"
          suffix="px на экране"
          value={editor.eraserSize}
          min={4}
          max={160}
          onStart={() => {}}
          onEnd={() => {}}
          onChange={(v) => {
            editor.eraserSize = v;
            localStorage.setItem("lightpen.eraserSize", String(v));
            editor.emit("ui");
            editor.emit("overlay");
          }}
        />
      ) : (
        <>
          <NumericProperty
            label="Непрозрачность"
            suffix="%"
            value={(single?.opacity ?? editor.style.opacity) * 100}
            min={5}
            max={100}
            disabled={disabled}
            onStart={start}
            onEnd={end}
            onChange={(v) => editor.setStyle({ opacity: v / 100 })}
          />
          {(isConnector ||
            ["connector", "arrow", "line"].includes(editor.tool)) && (
            <section className="property-section">
              <label className="field-label">
                Соединитель
                <select
                  aria-label="Вид соединителя"
                  value={single?.connectorStyle ?? editor.connectorStyle}
                  disabled={disabled}
                  onChange={(e) => {
                    const style = e.target.value as NonNullable<
                      SceneElement["connectorStyle"]
                    >;
                    editor.connectorStyle = style;
                    if (single)
                      editor.patchElement(single.id, { connectorStyle: style });
                    else editor.emit("ui");
                  }}
                >
                  <option value="straight">Прямой</option>
                  <option value="curve">Изогнутый</option>
                  <option value="orthogonal">Прямоугольный</option>
                </select>
              </label>
              {isConnector && (
                <label className="field-label">
                  Подпись
                  <input
                    aria-label="Подпись соединителя"
                    maxLength={2000}
                    defaultValue={single.label ?? ""}
                    key={single.id + ":" + (single.label ?? "")}
                    disabled={disabled}
                    onBlur={(e) => {
                      if (e.target.value !== (single.label ?? ""))
                        editor.patchElement(single.id, {
                          label: e.target.value,
                        });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                    }}
                  />
                </label>
              )}
            </section>
          )}
          {isConnector && single.label && (
            <NumericProperty
              label="Размер подписи"
              value={single.fontSize ?? 18}
              min={8}
              max={256}
              disabled={disabled}
              onStart={start}
              onEnd={end}
              onChange={(v) => editor.setStyle({ fontSize: v })}
            />
          )}
          {b && selection.length > 0 && (
            <section className="property-section">
              <NumericProperty
                label="Ширина"
                value={b.maxX - b.minX}
                min={8}
                max={Math.max(3000, Math.ceil(b.maxX - b.minX))}
                disabled={disabled}
                onStart={start}
                onEnd={end}
                onChange={(v) =>
                  editor.resizeSelection(
                    v,
                    editor.selectionBounds!.maxY - editor.selectionBounds!.minY,
                  )
                }
              />
              <NumericProperty
                label="Высота"
                value={b.maxY - b.minY}
                min={8}
                max={Math.max(3000, Math.ceil(b.maxY - b.minY))}
                disabled={disabled}
                onStart={start}
                onEnd={end}
                onChange={(v) =>
                  editor.resizeSelection(
                    editor.selectionBounds!.maxX - editor.selectionBounds!.minX,
                    v,
                  )
                }
              />
              {!selection.some((e) => e.startBinding || e.endBinding) && (
                <NumericProperty
                  label="Поворот"
                  suffix="°"
                  value={selection[0].rotation ?? 0}
                  min={-180}
                  max={180}
                  disabled={disabled}
                  onStart={start}
                  onEnd={end}
                  onChange={(v) => editor.rotateSelection(v, true)}
                />
              )}
            </section>
          )}
          {single && ["table", "task", "link"].includes(single.kind) && (
            <Button
              size="small"
              disabled={disabled}
              onClick={() => {
                editor.objectDraftMode = "content";
                editor.objectDraft = single;
                editor.emit("ui");
              }}
            >
              Редактировать{" "}
              {single.kind === "table"
                ? "таблицу"
                : single.kind === "task"
                  ? "задачу"
                  : "ссылку"}
              …
            </Button>
          )}
          {single?.link && (
            <Button
              size="small"
              appearance="primary"
              onClick={() => {
                editor.linkRequest = single.link;
                editor.emit("ui");
              }}
            >
              Открыть ссылку
            </Button>
          )}
          {single && single.kind !== "link" && (
            <Button
              size="small"
              appearance="subtle"
              disabled={disabled}
              onClick={() => {
                editor.objectDraftMode = "link";
                editor.objectDraft = {
                  ...single,
                  link: single.link ?? { path: "" },
                };
                editor.emit("ui");
              }}
            >
              {single.link ? "Изменить ссылку…" : "Добавить ссылку…"}
            </Button>
          )}
        </>
      )}
    </>
  );
}
export function PropertyDock({ editor }: { editor: Editor }) {
  if (
    editor.dock !== "properties" ||
    editor.replay ||
    editor.tool === "hand" ||
    (editor.tool === "select" && !editor.selected.size)
  )
    return null;
  const selection = editor.selection,
    single = selection.length === 1 ? selection[0] : null,
    sticky = single?.kind === "sticky" || editor.tool === "sticky",
    eraser = editor.tool === "eraser",
    text = single?.kind === "text" || editor.tool === "text",
    image = single?.kind === "image",
    kind = single?.kind ?? editor.tool;
  const color = single?.color ?? editor.style.color,
    fill = single?.fill ?? editor.style.fill,
    width =
      editor.tool === "highlighter"
        ? editor.markerSize
        : (single?.strokeWidth ?? editor.style.strokeWidth);
  return (
    <aside className="properties floating" aria-label="Свойства инструмента">
      <div className="panel-title">
        <strong>
          {selection.length > 1
            ? `Выбрано: ${selection.length}`
            : single
              ? KIND_NAMES[single.kind]
              : editor.tool === "pen"
                ? "Перо"
                : editor.tool === "highlighter"
                  ? "Маркер"
                  : eraser
                    ? "Ластик"
                    : editor.tool === "connector"
                      ? "Соединитель"
                      : (KIND_NAMES[editor.tool as SceneElement["kind"]] ??
                        "Свойства")}
        </strong>
        <Button
          size="small"
          appearance="subtle"
          icon={<Dismiss20Regular />}
          aria-label="Свернуть свойства"
          onClick={() => {
            editor.dock = null;
            editor.emit("ui");
          }}
        />
      </div>
      {!eraser && !image && (
        <>
          <div className="property-label">
            {sticky ? "Цвет стикера" : "Цвет"}
          </div>
          <div className="swatches">
            {(sticky ? STICKY_COLORS : COLORS).map((v) => (
              <button
                key={v}
                className={`swatch ${(sticky ? fill : color) === v ? "chosen" : ""}`}
                style={{ background: v }}
                aria-label={`Цвет ${v}`}
                aria-pressed={(sticky ? fill : color) === v}
                onClick={() =>
                  editor.setStyle(sticky ? { fill: v } : { color: v })
                }
              />
            ))}
          </div>
          <CustomColor editor={editor} fill={sticky} />
          {!sticky && !text && (
            <>
              <NumericProperty
                label={
                  editor.tool === "highlighter" ? "Размер маркера" : "Толщина"
                }
                value={
                  editor.tool === "highlighter" ? editor.markerSize : width
                }
                min={1}
                max={128}
                onStart={() => editor.beginStyle()}
                onEnd={() => editor.endStyle()}
                onChange={(v) => {
                  if (editor.tool === "highlighter") {
                    editor.markerSize = v;
                    localStorage.setItem("lightpen.markerSize", String(v));
                    editor.emit("ui");
                  } else editor.setStyle({ strokeWidth: v });
                }}
              />
              <div className="width-options">
                {[1.5, 3, 6, 12].map((v) => (
                  <button
                    key={v}
                    className={width === v ? "chosen" : ""}
                    aria-label={`Толщина ${v}`}
                    aria-pressed={width === v}
                    onClick={() => {
                      if (editor.tool === "highlighter") {
                        editor.markerSize = v;
                        localStorage.setItem("lightpen.markerSize", String(v));
                        editor.emit("ui");
                      } else editor.setStyle({ strokeWidth: v });
                    }}
                  >
                    <span style={{ height: Math.min(9, v) }} />
                  </button>
                ))}
              </div>
            </>
          )}
          {[
            "rectangle",
            "ellipse",
            "diamond",
            "table",
            "task",
            "link",
          ].includes(kind) && (
            <details className="property-disclosure">
              <summary>Заливка</summary>
              <div className="swatches fill-swatches">
                <button
                  className={`swatch transparent-swatch ${fill === "transparent" ? "chosen" : ""}`}
                  aria-label="Без заливки"
                  onClick={() => editor.setStyle({ fill: "transparent" })}
                />
                {STICKY_COLORS.slice(0, 5).map((v) => (
                  <button
                    key={v}
                    className={`swatch ${fill === v ? "chosen" : ""}`}
                    style={{ background: v }}
                    aria-label={`Заливка ${v}`}
                    onClick={() => editor.setStyle({ fill: v })}
                  />
                ))}
              </div>
              <CustomColor editor={editor} fill />
            </details>
          )}
          {([
            "text",
            "sticky",
            "math",
            "frame",
            "table",
            "task",
            "link",
          ].includes(kind) ||
            selection.some((e) =>
              [
                "text",
                "sticky",
                "math",
                "frame",
                "table",
                "task",
                "link",
              ].includes(e.kind),
            )) && <TextControls editor={editor} />}
        </>
      )}
      <ExtraProperties editor={editor} />
      {!!selection.length && (
        <div className="selection-actions">
          <Button
            size="small"
            appearance="subtle"
            onClick={() => editor.duplicate()}
          >
            Дублировать
          </Button>
          <Button
            size="small"
            appearance="subtle"
            onClick={() => editor.deleteSelection()}
            disabled={selection.every((e) => e.locked)}
          >
            Удалить
          </Button>
        </div>
      )}
      {!!selection.length && (
        <Button
          className="template-property-action"
          size="small"
          appearance="subtle"
          onClick={() => {
            editor.templateRequested = true;
            editor.emit("ui");
          }}
        >
          Сохранить выделение как шаблон…
        </Button>
      )}
    </aside>
  );
}
const INSERT_TOOLS: { tool: Tool; label: string }[] = [
  { tool: "sticky", label: "Стикер" },
  { tool: "text", label: "Текст" },
  { tool: "rectangle", label: "Прямоугольник" },
  { tool: "ellipse", label: "Эллипс" },
  { tool: "diamond", label: "Ромб" },
  { tool: "connector", label: "Соединитель" },
  { tool: "frame", label: "Фрейм" },
  { tool: "math", label: "Формула LaTeX" },
];
export function Studio({
  editor,
  onExport,
  onPresent,
  notify,
  onError,
}: {
  editor: Editor;
  onExport: () => void;
  onPresent: () => void;
  notify: (s: string) => void;
  onError: (s: string) => void;
}) {
  const [query, setQuery] = useState(""),
    [limit, setLimit] = useState(150),
    [templates, setTemplates] = useState<TemplateSummary[]>([]),
    [templateName, setTemplateName] = useState("Новый шаблон"),
    [savingTemplate, setSavingTemplate] = useState(false),
    [planning, setPlanningState] = useState(false),
    [working, setWorking] = useState(false);
  const planningOpen = useRef(planning);
  planningOpen.current = planning;
  const setPlanning = (open: boolean) => {
    if (editor.agentPanel?.kind === "planning") editor.agentPanel = null;
    planningOpen.current = open;
    setPlanningState(open);
  };
  useEffect(() => {
    const fn = async () => {
      setPlanning(true);
      editor.agentPanel = {
        kind: "planning",
        close: () => setPlanning(false),
        isOpen: () => planningOpen.current,
      };
      return { panel: "planning" };
    };
    editor.services.set("panel_planning", fn);
    return () => {
      editor.services.delete("panel_planning");
      if (editor.agentPanel?.kind === "planning") editor.agentPanel = null;
    };
  }, [editor]);
  const panel = editor.dock;
  useEffect(() => {
    if (editor.templateRequested) {
      editor.templateRequested = false;
      setSavingTemplate(true);
    }
  }, [editor, editor.templateRequested]);
  const run = async (fn: () => Promise<void>) => {
    if (working) return;
    setWorking(true);
    try {
      await fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };
  useEffect(() => {
    if (panel === "templates")
      void listTemplates()
        .then(setTemplates)
        .catch((e) => onError(String(e)));
  }, [panel, onError]);
  const objects = useMemo(
    () =>
      [...editor.elements]
        .reverse()
        .filter((e) =>
          `${e.name ?? ""} ${e.text ?? ""} ${KIND_NAMES[e.kind]}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase()),
        ),
    [editor.elements, query],
  );
  const librarySave = () =>
    void run(async () => {
      const elements = editor.selection;
      if (!elements.length) throw new Error("Выделите объекты для шаблона.");
      const doc = {
        ...createDocument(templateName.trim().slice(0, 250) || "Новый шаблон"),
        elements: importFragmentElements(
          buildFragment(
            editor.document,
            elements.map((e) => e.id),
          ),
          { pageId: "main" },
        ).elements,
      };
      await saveTemplate(doc);
      setTemplates(await listTemplates());
      setSavingTemplate(false);
      editor.dock = "templates";
      editor.emit("ui");
      notify("Шаблон сохранён в библиотеке");
    });
  return (
    <>
      <div className="studio-switcher floating" aria-label="Панели доски">
        <Tooltip content="Объекты и слои" relationship="label">
          <Button
            appearance="subtle"
            icon={<Layer20Regular />}
            aria-label="Объекты и слои"
            aria-pressed={panel === "objects"}
            onClick={() => editor.setDock("objects")}
          />
        </Tooltip>
        <Tooltip content="Вставить" relationship="label">
          <Button
            appearance="subtle"
            icon={<Add20Regular />}
            aria-label="Вставить объект"
            aria-pressed={panel === "insert"}
            onClick={() => editor.setDock("insert")}
          />
        </Tooltip>
        <Tooltip content="Шаблоны" relationship="label">
          <Button
            appearance="subtle"
            icon={<Library20Regular />}
            aria-label="Библиотека шаблонов"
            aria-pressed={panel === "templates"}
            onClick={() => editor.setDock("templates")}
          />
        </Tooltip>
        <Tooltip content="Экспорт" relationship="label">
          <Button
            appearance="subtle"
            icon={<ArrowDownload20Regular />}
            aria-label="Экспорт доски"
            onClick={onExport}
          />
        </Tooltip>
      </div>
      {(["objects", "insert", "templates"] as (typeof panel)[]).includes(
        panel,
      ) && (
        <aside
          className="studio-panel floating"
          aria-label={
            panel === "objects"
              ? "Объекты и слои"
              : panel === "insert"
                ? "Вставка"
                : "Шаблоны"
          }
        >
          <div className="panel-title">
            <strong>
              {panel === "objects"
                ? "Объекты и слои"
                : panel === "insert"
                  ? "Вставить на доску"
                  : "Мои шаблоны"}
            </strong>
            <Button
              size="small"
              appearance="subtle"
              icon={<Dismiss20Regular />}
              aria-label="Закрыть панель"
              onClick={() => editor.setDock(panel)}
            />
          </div>
          {panel === "objects" && (
            <>
              <input
                className="search-field"
                aria-label="Фильтр объектов"
                placeholder="Название или текст"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setLimit(150);
                }}
              />
              <p className="panel-hint">
                Сверху — передний план. Shift — выбрать несколько.
              </p>
              <div className="object-list">
                {objects.slice(0, limit).map((e) => (
                  <div
                    className={`object-row ${editor.selected.has(e.id) ? "selected" : ""} ${e.hidden ? "hidden-object" : ""}`}
                    key={e.id}
                  >
                    <button
                      className="object-pick"
                      aria-label={`Выбрать ${e.name || e.text?.slice(0, 24) || KIND_NAMES[e.kind]}`}
                      onClick={(event) =>
                        editor.selectObject(e.id, event.shiftKey)
                      }
                      onDoubleClick={() => editor.focusElement(e.id)}
                    >
                      <ToolIcon
                        tool={
                          e.kind === "stroke"
                            ? "pen"
                            : e.kind === "image"
                              ? "rectangle"
                              : e.kind
                        }
                      />
                    </button>
                    <div className="object-name">
                      <input
                        aria-label={`Имя объекта ${e.id}`}
                        defaultValue={
                          e.name ?? e.text?.slice(0, 40) ?? KIND_NAMES[e.kind]
                        }
                        key={`${e.id}:${e.name}`}
                        maxLength={250}
                        onFocus={() => editor.selectObject(e.id)}
                        onBlur={(event) => {
                          if (
                            event.target.value !==
                            (e.name ??
                              e.text?.slice(0, 40) ??
                              KIND_NAMES[e.kind])
                          )
                            editor.patchElement(
                              e.id,
                              { name: event.target.value },
                              "Имя объекта",
                              true,
                            );
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                      <small>
                        {KIND_NAMES[e.kind]}
                        {e.groupId ? " · группа" : ""}
                      </small>
                    </div>
                    <button
                      className="mini-action"
                      aria-label={`${e.hidden ? "Показать" : "Скрыть"} ${e.name || KIND_NAMES[e.kind]}`}
                      title={e.hidden ? "Показать" : "Скрыть"}
                      onClick={() =>
                        editor.patchElement(
                          e.id,
                          { hidden: !e.hidden },
                          "Видимость",
                          true,
                        )
                      }
                    >
                      {e.hidden ? "◌" : "●"}
                    </button>
                    <button
                      className="mini-action"
                      aria-label={`${e.locked ? "Открепить" : "Закрепить"} ${e.name || KIND_NAMES[e.kind]}`}
                      title={e.locked ? "Открепить" : "Закрепить"}
                      onClick={() =>
                        editor.patchElement(
                          e.id,
                          { locked: !e.locked },
                          "Закрепление",
                          true,
                        )
                      }
                    >
                      {e.locked ? "▣" : "◇"}
                    </button>
                    <div className="layer-arrows">
                      <button
                        aria-label={`Поднять ${e.id}`}
                        onClick={() => editor.moveLayer(e.id, 1)}
                      >
                        ↑
                      </button>
                      <button
                        aria-label={`Опустить ${e.id}`}
                        onClick={() => editor.moveLayer(e.id, -1)}
                      >
                        ↓
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              {objects.length > limit && (
                <Button size="small" onClick={() => setLimit(limit + 150)}>
                  Показать ещё ({objects.length - limit})
                </Button>
              )}
              {!objects.length && (
                <p className="panel-hint">
                  Объектов пока нет. Добавьте стикер или нарисуйте линию.
                </p>
              )}
              {!!editor.selected.size && (
                <Button
                  size="small"
                  onClick={() => {
                    editor.dock = "properties";
                    editor.emit("ui");
                  }}
                >
                  Свойства выделения
                </Button>
              )}
            </>
          )}
          {panel === "insert" && (
            <>
              <div className="insert-grid">
                {INSERT_TOOLS.map((t) => (
                  <button
                    key={t.tool}
                    className="insert-tile"
                    onClick={() => editor.setTool(t.tool)}
                  >
                    <ToolIcon tool={t.tool} />
                    <span>{t.label}</span>
                  </button>
                ))}
                {(
                  [
                    ["arrow", "Стрелка"],
                    ["line", "Линия"],
                  ] as const
                ).map(([tool, label]) => (
                  <button
                    className="insert-tile"
                    key={tool}
                    onClick={() => editor.setTool(tool)}
                  >
                    <ToolIcon tool={tool} />
                    <span>{label}</span>
                  </button>
                ))}
                {(
                  [
                    ["table", "Таблица"],
                    ["task", "Задача / чек-лист"],
                    ["link", "Локальная ссылка"],
                  ] as const
                ).map(([kind, label]) => (
                  <button
                    className="insert-tile"
                    key={kind}
                    onClick={() => editor.addStructured(kind)}
                  >
                    <ToolIcon tool={kind} />
                    <span>{label}</span>
                  </button>
                ))}
                <button
                  className="insert-tile"
                  onClick={() => editor.insertElements(builtinKanban())}
                >
                  <ToolIcon tool="sticky" />
                  <span>Канбан из трёх колонок</span>
                </button>
              </div>
              <div className="property-section">
                <Button
                  icon={<Presenter20Regular />}
                  appearance="subtle"
                  onClick={() => setPlanning(true)}
                >
                  Планирование задач…
                </Button>
                <Button
                  icon={<Library20Regular />}
                  appearance="subtle"
                  onClick={() => {
                    editor.dock = "templates";
                    editor.emit("ui");
                  }}
                >
                  Мои шаблоны
                </Button>
                <Button
                  icon={<Presenter20Regular />}
                  appearance="subtle"
                  disabled={!editor.slides.length}
                  onClick={onPresent}
                >
                  Презентация фреймов
                </Button>
              </div>
            </>
          )}
          {panel === "templates" && (
            <>
              <div className="panel-inline-actions">
                <Button
                  size="small"
                  appearance="primary"
                  disabled={!editor.selected.size}
                  onClick={() => setSavingTemplate(true)}
                >
                  Из выделения
                </Button>
                <Button
                  size="small"
                  disabled={working}
                  onClick={() =>
                    void run(async () => {
                      const doc = await importTemplate();
                      if (!doc) return;
                      await saveTemplate({ ...doc, id: uid() });
                      setTemplates(await listTemplates());
                      notify("Шаблон импортирован");
                    })
                  }
                >
                  Импорт…
                </Button>
              </div>
              <div className="template-list">
                {templates.map((doc) => (
                  <div className="template-item" key={doc.id}>
                    <button
                      className="template-insert"
                      onClick={() =>
                        void run(async () =>
                          editor.insertElements(
                            (await readTemplate(doc.id)).elements,
                          ),
                        )
                      }
                    >
                      <TemplatePreview elements={doc.elements} />
                      <strong>{doc.title}</strong>
                      <small>{doc.objects} объектов</small>
                    </button>
                    <div className="panel-inline-actions">
                      <Button
                        size="small"
                        appearance="subtle"
                        onClick={() =>
                          void run(async () =>
                            exportTemplate(await readTemplate(doc.id)),
                          )
                        }
                      >
                        Экспорт…
                      </Button>
                      <Button
                        size="small"
                        appearance="subtle"
                        onClick={() =>
                          void run(async () => {
                            await removeTemplate(doc.id);
                            setTemplates(await listTemplates());
                          })
                        }
                      >
                        Удалить
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              {!templates.length && (
                <p className="panel-hint">
                  Выделите фрагмент доски и сохраните его здесь. Шаблон можно
                  вставлять в другие доски и переносить отдельным файлом.
                </p>
              )}
            </>
          )}
        </aside>
      )}
      {editor.objectDraft && (
        <StructuredEditor
          key={editor.objectDraft.id}
          editor={editor}
          element={editor.objectDraft}
        />
      )}
      {planning && (
        <Planning
          key={editor.document.id}
          editor={editor}
          onClose={() => setPlanning(false)}
          onError={onError}
        />
      )}
      <Dialog
        open={savingTemplate}
        onOpenChange={(_, d) => setSavingTemplate(d.open)}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Сохранить шаблон</DialogTitle>
            <DialogContent>
              <label className="field-label">
                Название
                <input
                  aria-label="Название шаблона"
                  value={templateName}
                  maxLength={250}
                  onChange={(e) => setTemplateName(e.target.value)}
                />
              </label>
              <p className="panel-hint">
                В библиотеку попадут выбранные объекты. Исходная доска
                сохранится.
              </p>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setSavingTemplate(false)}>Отмена</Button>
              <Button
                appearance="primary"
                disabled={working || !editor.selected.size}
                onClick={librarySave}
              >
                Сохранить шаблон
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
function TemplatePreview({ elements }: { elements: SceneElement[] }) {
  const boxes = elements.slice(0, 120).map((e) => bounds(e));
  const minX = Math.min(...boxes.map((b) => b.minX)),
    minY = Math.min(...boxes.map((b) => b.minY)),
    w = Math.max(1, Math.max(...boxes.map((b) => b.maxX)) - minX),
    h = Math.max(1, Math.max(...boxes.map((b) => b.maxY)) - minY);
  return (
    <svg
      viewBox={`${minX - 12} ${minY - 12} ${w + 24} ${h + 24}`}
      aria-hidden="true"
    >
      {elements.slice(0, 120).map((e, i) => {
        const b = boxes[i];
        return (
          <rect
            key={e.id}
            x={b.minX}
            y={b.minY}
            width={b.maxX - b.minX}
            height={b.maxY - b.minY}
            rx={3}
            fill={e.fill === "transparent" ? "none" : e.fill}
            stroke={e.color}
            strokeWidth={Math.max(1, Math.max(w, h) / 180)}
          />
        );
      })}
    </svg>
  );
}

export function builtinKanban(): SceneElement[] {
  return ["План", "В работе", "Готово"].map((text, i) => ({
    ...createElement("sticky", i * 280, 0, {
      ...DEFAULT_STYLE,
      fill: ["#fff1a8", "#cfe9fd", "#d7efd9"][i],
      fontSize: 24,
    }),
    width: 250,
    height: 380,
    text,
  }));
}
