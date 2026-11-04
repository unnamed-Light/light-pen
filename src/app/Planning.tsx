import { useMemo, useState, useSyncExternalStore } from "react";
import {
  Button,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  TabList,
  Tab,
} from "@fluentui/react-components";
import type { Editor } from "../editor/editor";
import type { SceneElement, TaskData } from "../editor/model/types";
import { isDate } from "../editor/model/types";
import {
  PRIORITY_NAMES,
  queryTasks,
  taskIssues,
  taskInterval,
  dayNumber,
  isoDay,
  calendarDays,
  taskCounts,
} from "../editor/model/tasks";
import type { TaskQuery, TaskIssue } from "../editor/model/tasks";
import { STATUS_TEXT } from "../editor/render/structured";
import { saveDataText } from "../platform/native";
import { toCsv } from "../editor/model/tables";

type View = "kanban" | "calendar" | "timeline" | "summary";
type TaskElement = SceneElement & { task: TaskData };
function Issues({ issue }: { issue: TaskIssue | undefined }) {
  const messages = [];
  if (issue?.cyclic) messages.push("Цикл зависимостей");
  if (issue?.missing.length) messages.push("Зависимая задача удалена");
  if (issue?.blocked.length) messages.push("Есть незавершённые зависимости");
  if (issue?.invertedDates) messages.push("Начало позже срока");
  return messages.length ? (
    <small className="planning-warning">{messages.join(". ")}</small>
  ) : null;
}
export function Planning({
  editor,
  onClose,
  onError,
}: {
  editor: Editor;
  onClose: () => void;
  onError: (s: string) => void;
}) {
  useSyncExternalStore(editor.subscribeUi, editor.getSnapshot);
  const [view, setView] = useState<View>("kanban"),
    [query, setQuery] = useState<TaskQuery>({}),
    [limit, setLimit] = useState(150);
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const [month, setMonth] = useState(today.slice(0, 7)),
    [start, setStart] = useState(today),
    [days, setDays] = useState(30);
  const [dateFilter, setDateFilter] = useState("");
  const all = useMemo(
    () => queryTasks(editor.elements, { archived: !!query.archived }),
    [editor.elements, query.archived],
  );
  const tasks = useMemo(
    () => queryTasks(editor.elements, query),
    [editor.elements, query],
  );
  const issues = useMemo(
    () => taskIssues(editor.document.elements),
    [editor.document.elements],
  );
  const timedTasks = useMemo(
    () => tasks.map((task) => ({ task, interval: taskInterval(task.task) })),
    [tasks],
  );
  const selected = tasks.filter(
    (e) =>
      !dateFilter ||
      ((e.task.start ?? e.task.due ?? "") <= dateFilter &&
        (e.task.due ?? e.task.start ?? "") >= dateFilter),
  );
  const visible = selected.slice(0, limit);
  const tags = [...new Set(all.flatMap((e) => e.task.tags ?? []))].sort();
  const canWrite = (task: SceneElement) => !editor.readOnly && !task.locked;
  const status = (id: string, value: TaskData["status"]) => {
    const task = editor.elements.find((e) => e.id === id);
    if (!task?.task || !canWrite(task) || task.task.status === value) return;
    editor.commit(
      editor.elements.map((e) =>
        e.id === id ? { ...e, task: { ...e.task!, status: value } } : e,
      ),
      "Статус задачи",
    );
  };
  const reveal = (task: SceneElement, edit = false) => {
    editor.selected = new Set([task.id]);
    editor.fit(true);
    editor.dock = "properties";
    if (edit && canWrite(task)) {
      editor.objectDraftMode = "content";
      editor.objectDraft = structuredClone(task);
    }
    onClose();
    editor.emit("ui");
    editor.emit("overlay");
  };
  const card = (task: TaskElement, compact = false) => (
    <article
      key={task.id}
      className={`planning-card ${compact ? "compact" : ""}`}
      draggable={canWrite(task)}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-lightpen-task", task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
    >
      <button
        className="planning-card-title"
        onClick={() => reveal(task, true)}
      >
        {task.text || "Без названия"}
      </button>
      <span className="planning-card-meta">
        {task.task.priority && task.task.priority !== "none"
          ? PRIORITY_NAMES[task.task.priority] + " · "
          : ""}
        {task.task.due ? `до ${task.task.due}` : "Без срока"}
        {task.task.archived ? " · Архив" : ""}
      </span>
      <span className="planning-card-meta">
        {task.task.items.filter((i) => i.done).length}/{task.task.items.length}{" "}
        пунктов
        {task.task.estimate !== undefined ? ` · ${task.task.estimate} ч` : ""}
      </span>
      {!!task.task.tags?.length && (
        <span className="planning-tags">{task.task.tags.join(", ")}</span>
      )}
      <Issues issue={issues.get(task.id)} />
      <select
        aria-label={`Статус ${task.id}`}
        value={task.task.status}
        disabled={!canWrite(task)}
        onChange={(e) => status(task.id, e.target.value as TaskData["status"])}
      >
        {Object.entries(STATUS_TEXT).map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
    </article>
  );
  const moveMonth = (direction: number) => {
    const d = new Date(month + "-15T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + direction);
    const y = d.getUTCFullYear();
    if (y >= 1 && y <= 9999) setMonth(d.toISOString().slice(0, 7));
  };
  const exportCsv = () =>
    void saveDataText(
      toCsv([
        [
          "Задача",
          "Статус",
          "Приоритет",
          "Начало",
          "Срок",
          "Оценка, ч",
          "Теги",
          "Описание",
        ],
        ...selected.map((e) => [
          e.text ?? "",
          STATUS_TEXT[e.task.status],
          PRIORITY_NAMES[e.task.priority ?? "none"],
          e.task.start ?? "",
          e.task.due ?? "",
          e.task.estimate === undefined ? "" : String(e.task.estimate),
          e.task.tags?.join(", ") ?? "",
          e.task.description ?? "",
        ]),
      ]),
      editor.document.title + " — задачи",
      "csv",
    ).catch((e) => onError(String(e)));
  const counts = taskCounts(selected, true),
    maxCount = Math.max(1, ...Object.values(counts.byStatus));
  return (
    <Dialog
      open
      onOpenChange={(_, d) => {
        if (!d.open) onClose();
      }}
    >
      <DialogSurface className="planning-dialog">
        <DialogBody>
          <DialogTitle>Планирование</DialogTitle>
          <DialogContent>
            <TabList
              selectedValue={view}
              onTabSelect={(_, d) => {
                setView(d.value as View);
                setDateFilter("");
              }}
              aria-label="Представления задач"
            >
              <Tab value="kanban">Канбан</Tab>
              <Tab value="calendar">Календарь</Tab>
              <Tab value="timeline">Таймлайн</Tab>
              <Tab value="summary">Обзор</Tab>
            </TabList>
            <div className="planning-filters">
              <input
                aria-label="Поиск задач"
                placeholder="Найти задачу"
                value={query.search ?? ""}
                onChange={(e) => {
                  setQuery({ ...query, search: e.target.value });
                  setLimit(150);
                }}
              />
              <select
                aria-label="Фильтр приоритета"
                value={query.priority ?? ""}
                onChange={(e) =>
                  setQuery({
                    ...query,
                    priority:
                      (e.target.value as TaskData["priority"]) || undefined,
                  })
                }
              >
                <option value="">Все приоритеты</option>
                {Object.entries(PRIORITY_NAMES).map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
              <select
                aria-label="Фильтр тега"
                value={query.tag ?? ""}
                onChange={(e) =>
                  setQuery({ ...query, tag: e.target.value || undefined })
                }
              >
                <option value="">Все теги</option>
                {tags.map((tag) => (
                  <option key={tag}>{tag}</option>
                ))}
              </select>
              <label className="data-checkbox">
                <input
                  type="checkbox"
                  checked={!!query.archived}
                  onChange={(e) =>
                    setQuery({ ...query, archived: e.target.checked })
                  }
                />
                Архив
              </label>
            </div>
            {!tasks.length && (
              <p className="planning-empty">
                Задач пока нет. Добавьте карточку через «Вставить объект» или
                измените фильтры.
              </p>
            )}
            {!!dateFilter && (
              <div className="planning-toolbar">
                <span>Задачи на {dateFilter}</span>
                <Button size="small" onClick={() => setDateFilter("")}>
                  Сбросить дату
                </Button>
              </div>
            )}
            {view === "kanban" && (
              <div className="planning-kanban">
                {(Object.keys(STATUS_TEXT) as TaskData["status"][]).map(
                  (value) => (
                    <section
                      key={value}
                      className="planning-column"
                      aria-label={`Колонка ${STATUS_TEXT[value]}`}
                      onDragOver={(e) => {
                        if (
                          !editor.readOnly &&
                          e.dataTransfer.types.includes(
                            "application/x-lightpen-task",
                          )
                        )
                          e.preventDefault();
                      }}
                      onDrop={(e) => {
                        const id = e.dataTransfer.getData(
                          "application/x-lightpen-task",
                        );
                        if (id) {
                          e.preventDefault();
                          status(id, value);
                        }
                      }}
                    >
                      <h3>
                        {STATUS_TEXT[value]}
                        <span>
                          {
                            selected.filter((e) => e.task.status === value)
                              .length
                          }
                        </span>
                      </h3>
                      {visible
                        .filter((e) => e.task.status === value)
                        .map((e) => card(e))}
                    </section>
                  ),
                )}
              </div>
            )}
            {view === "calendar" && (
              <>
                <div className="planning-toolbar">
                  <Button
                    size="small"
                    aria-label="Предыдущий месяц"
                    onClick={() => moveMonth(-1)}
                  >
                    ←
                  </Button>
                  <input
                    type="month"
                    aria-label="Месяц календаря"
                    min="0001-01"
                    max="9999-12"
                    value={month}
                    onChange={(e) => {
                      if (/^\d{4}-\d{2}$/.test(e.target.value))
                        setMonth(e.target.value);
                    }}
                  />
                  <Button
                    size="small"
                    aria-label="Следующий месяц"
                    onClick={() => moveMonth(1)}
                  >
                    →
                  </Button>
                  <Button
                    size="small"
                    onClick={() => setMonth(today.slice(0, 7))}
                  >
                    Сегодня
                  </Button>
                </div>
                <div className="planning-calendar" aria-label="Календарь задач">
                  {["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => (
                    <strong key={day}>{day}</strong>
                  ))}
                  {calendarDays(month).map((day) => {
                    const dayTasks = timedTasks
                      .filter(({ interval: i }) => {
                        return (
                          i &&
                          !i.inverted &&
                          i.start <= dayNumber(day) &&
                          i.end >= dayNumber(day)
                        );
                      })
                      .map((item) => item.task);
                    return (
                      <div
                        key={day}
                        className={`calendar-day ${day.slice(0, 7) !== month ? "outside" : ""} ${day === today ? "today" : ""}`}
                      >
                        <button
                          className="calendar-date"
                          aria-label={`Задачи на ${day}`}
                          onClick={() => {
                            setDateFilter(day);
                            setView("kanban");
                          }}
                        >
                          {Number(day.slice(-2))}
                          <span>{dayTasks.length || ""}</span>
                        </button>
                        {dayTasks.slice(0, 3).map((task) => (
                          <button
                            className={`calendar-task status-${task.task.status}`}
                            key={task.id}
                            onClick={() => reveal(task, true)}
                            title={task.text}
                          >
                            {task.text || "Задача"}
                          </button>
                        ))}
                        {dayTasks.length > 3 && (
                          <button
                            className="calendar-more"
                            onClick={() => {
                              setDateFilter(day);
                              setView("kanban");
                            }}
                          >
                            Ещё {dayTasks.length - 3}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="panel-hint">
                  Задачи без дат остаются в канбане. Нажмите на число, чтобы
                  увидеть все задачи выбранного дня.
                </p>
              </>
            )}
            {view === "timeline" && (
              <>
                <div className="planning-toolbar">
                  <label>
                    Начало{" "}
                    <input
                      type="date"
                      aria-label="Начало таймлайна"
                      min="0001-01-01"
                      max="9999-12-31"
                      value={start}
                      onChange={(e) => {
                        if (isDate(e.target.value)) setStart(e.target.value);
                      }}
                    />
                  </label>
                  <select
                    aria-label="Масштаб таймлайна"
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                  >
                    <option value={7}>Неделя</option>
                    <option value={30}>Месяц</option>
                    <option value={90}>Квартал</option>
                    <option value={365}>Год</option>
                  </select>
                  <Button size="small" onClick={() => setStart(today)}>
                    Сегодня
                  </Button>
                </div>
                <div className="planning-timeline">
                  <div className="timeline-heading">
                    <span>{start}</span>
                    <span>{isoDay(dayNumber(start) + days - 1)}</span>
                  </div>
                  {visible.map((task) => {
                    const interval = taskInterval(task.task),
                      left = interval
                        ? Math.max(
                            0,
                            Math.min(
                              100,
                              ((interval.start - dayNumber(start)) / days) *
                                100,
                            ),
                          )
                        : 0,
                      right = interval
                        ? Math.max(
                            0,
                            Math.min(
                              100,
                              ((interval.end - dayNumber(start) + 1) / days) *
                                100,
                            ),
                          )
                        : 0;
                    const outside =
                      !!interval &&
                      (interval.end < dayNumber(start) ||
                        interval.start >= dayNumber(start) + days);
                    return (
                      <div className="timeline-row" key={task.id}>
                        <button onClick={() => reveal(task, true)}>
                          {task.text || "Задача"}
                          <Issues issue={issues.get(task.id)} />
                        </button>
                        <div className="timeline-track">
                          {!interval || interval.inverted || outside ? (
                            <span className="timeline-unscheduled">
                              {!interval
                                ? "Без дат"
                                : interval.inverted
                                  ? "Проверьте даты"
                                  : "Вне текущей шкалы"}
                            </span>
                          ) : (
                            <button
                              className={`timeline-bar status-${task.task.status}`}
                              style={{
                                left: left + "%",
                                width: Math.max(0.7, right - left) + "%",
                              }}
                              onClick={() => reveal(task, true)}
                              title={`${task.task.start ?? task.task.due} — ${task.task.due ?? task.task.start}`}
                              aria-label={`Сроки ${task.text}`}
                            >
                              {task.task.start ?? task.task.due} —{" "}
                              {task.task.due ?? task.task.start}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
            {view === "summary" && (
              <div className="planning-summary">
                <p>
                  {counts.total} задач. Пунктов выполнено:{" "}
                  {counts.completedItems} из {counts.items}. Оценка времени:{" "}
                  {counts.estimate.toLocaleString("ru")} ч.
                </p>
                <svg
                  viewBox="0 0 650 150"
                  role="img"
                  aria-label="Задачи по статусам"
                >
                  {(
                    Object.entries(counts.byStatus) as [
                      TaskData["status"],
                      number,
                    ][]
                  ).map(([status, count], i) => (
                    <g key={status}>
                      <text x="0" y={i * 45 + 25}>
                        {STATUS_TEXT[status]}
                      </text>
                      <rect
                        className={`status-${status}`}
                        x="160"
                        y={i * 45 + 8}
                        width={(count / maxCount) * 400}
                        height="24"
                        rx="3"
                      />
                      <text x={170 + (count / maxCount) * 400} y={i * 45 + 25}>
                        {count}
                      </text>
                    </g>
                  ))}
                </svg>
                <table className="planning-summary-table">
                  <thead>
                    <tr>
                      <th>Статус</th>
                      <th>Задач</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(counts.byStatus).map(([s, n]) => (
                      <tr key={s}>
                        <td>{STATUS_TEXT[s as TaskData["status"]]}</td>
                        <td>{n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {view !== "calendar" && selected.length > limit && (
              <Button size="small" onClick={() => setLimit((n) => n + 150)}>
                Показать ещё ({selected.length - limit})
              </Button>
            )}
          </DialogContent>
          <DialogActions>
            <span className="planning-count" role="status">
              {selected.length} задач
              {editor.readOnly ? " · Только просмотр" : ""}
            </span>
            <Button onClick={exportCsv}>Экспорт CSV…</Button>
            <Button appearance="primary" onClick={onClose}>
              Вернуться к доске
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
