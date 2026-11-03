import { useRef, useState, useEffect } from "react";
import { Button } from "@fluentui/react-components";
import type { FieldType, SceneElement } from "../editor/model/types";
import {
  columnSummary,
  gridOf,
  queryRecords,
  replaceTableCells,
} from "../editor/model/data";
import type { DataQuery } from "../editor/model/data";
import { parseCsv, toCsv } from "../editor/model/tables";
import { saveDataText } from "../platform/native";

const FIELD_NAMES: Record<FieldType, string> = {
  text: "Текст",
  number: "Число",
  date: "Дата",
  checkbox: "Флажок",
  select: "Выбор",
  url: "Ссылка",
};
function ListInput({
  label,
  values,
  separator,
  maxLength,
  onChange,
}: {
  label: string;
  values: string[];
  separator: string;
  maxLength: number;
  onChange: (values: string[]) => void;
}) {
  const serialized = values.join(separator + " ");
  const [text, setText] = useState(serialized);
  useEffect(() => setText(serialized), [serialized]);
  return (
    <input
      aria-label={label}
      value={text}
      maxLength={maxLength}
      onChange={(e) => setText(e.target.value)}
      onBlur={() =>
        onChange([
          ...new Set(
            text
              .split(separator)
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        ])
      }
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}
export function DataControls({
  element,
  column,
  query,
  onQuery,
  onChange,
  onError,
}: {
  element: SceneElement;
  column: number;
  query: DataQuery;
  onQuery: (q: DataQuery) => void;
  onChange: (e: SceneElement) => void;
  onError: (s: string) => void;
}) {
  const grid = gridOf(element),
    field = grid.columns[column],
    summary = columnSummary(element, column);
  const file = useRef<HTMLInputElement>(null);
  const update = (p: Partial<typeof field>) =>
    onChange({
      ...element,
      grid: {
        ...grid,
        columns: grid.columns.map((c, i) =>
          i === column ? { ...c, ...p } : c,
        ),
      },
    });
  return (
    <details className="property-disclosure data-settings">
      <summary>Поля, фильтры и обмен данными</summary>
      <div className="form-pair">
        <label className="field-label">
          Поле {column + 1}: {element.cells![0][column] || "Без названия"}
          <select
            aria-label="Тип выбранного поля"
            value={field.type}
            onChange={(e) => update({ type: e.target.value as FieldType })}
          >
            {Object.entries(FIELD_NAMES).map(([v, n]) => (
              <option key={v} value={v}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Поиск по записям
          <input
            aria-label="Поиск записей таблицы"
            value={query.search ?? ""}
            onChange={(e) => onQuery({ ...query, search: e.target.value })}
          />
        </label>
      </div>
      {field.type === "select" && (
        <label className="field-label">
          Варианты через точку с запятой
          <ListInput
            key={field.id}
            label="Варианты выбранного поля"
            values={field.options ?? []}
            separator=";"
            maxLength={25000}
            onChange={(options) => update({ options: options.slice(0, 100) })}
          />
        </label>
      )}
      <div className="form-pair">
        <label className="field-label">
          Порядок записей
          <select
            aria-label="Сортировка таблицы"
            value={query.sort ?? ""}
            onChange={(e) =>
              onQuery({
                ...query,
                column: query.column ?? field.id,
                sort: (e.target.value as DataQuery["sort"]) || undefined,
              })
            }
          >
            <option value="">Как в таблице</option>
            <option value="asc">По возрастанию</option>
            <option value="desc">По убыванию</option>
          </select>
        </label>
        <label className="field-label">
          Поле сортировки
          <select
            aria-label="Поле сортировки таблицы"
            value={query.column ?? field.id}
            onChange={(e) => onQuery({ ...query, column: e.target.value })}
          >
            {grid.columns.map((c, i) => (
              <option key={c.id} value={c.id}>
                {element.cells![0][i] || `Поле ${i + 1}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="data-checkbox">
        <input
          type="checkbox"
          aria-label="Только записи с ошибками"
          checked={!!query.errorsOnly}
          onChange={(e) => onQuery({ ...query, errorsOnly: e.target.checked })}
        />
        Только записи с ошибками
      </label>
      <p className="panel-hint" role="status">
        Заполнено: {summary.count}. Ошибок типа: {summary.errors}.
        {field.type === "number"
          ? ` Сумма: ${summary.sum.toLocaleString("ru")}. Среднее: ${summary.average?.toLocaleString("ru") ?? "—"}.`
          : ""}{" "}
        Неверное значение сохраняется, чтобы его можно было исправить. При
        экспорте CSV формулы превращаются в текст для безопасного открытия в
        Excel.
      </p>
      <div className="panel-inline-actions">
        <Button
          size="small"
          disabled={!query.sort || !!query.search || !!query.errorsOnly}
          onClick={() => {
            const order = [
              0,
              ...queryRecords(element, query).map((r) => r.index),
            ];
            onChange({
              ...element,
              cells: order.map((r) => element.cells![r]),
              grid: { ...grid, rows: order.map((r) => grid.rows[r]) },
            });
            onQuery({});
          }}
        >
          Применить порядок
        </Button>
        <Button size="small" onClick={() => file.current?.click()}>
          Импорт CSV…
        </Button>
        <Button
          size="small"
          onClick={() =>
            void saveDataText(
              toCsv(element.cells!),
              element.text || "Таблица",
              "csv",
            ).catch((e) => onError(String(e)))
          }
        >
          Экспорт CSV…
        </Button>
      </div>
      <input
        ref={file}
        type="file"
        accept=".csv,text/csv"
        aria-label="Файл CSV"
        hidden
        onChange={async (e) => {
          const selected = e.currentTarget.files?.[0];
          e.currentTarget.value = "";
          if (!selected) return;
          try {
            if (selected.size > 2_000_000)
              throw new Error("Файл CSV превышает 2 МБ.");
            const cells = parseCsv(await selected.text());
            onChange(replaceTableCells(element, cells));
            onQuery({});
            onError("");
          } catch (error) {
            onError(String(error));
          }
        }}
      />
    </details>
  );
}
export function TaskDetails({
  element,
  elements,
  onChange,
}: {
  element: SceneElement;
  elements: SceneElement[];
  onChange: (e: SceneElement) => void;
}) {
  const task = element.task!;
  const update = (p: Partial<typeof task>) =>
    onChange({ ...element, task: { ...task, ...p } });
  return (
    <details className="property-disclosure task-details">
      <summary>Описание и планирование</summary>
      <label className="field-label">
        Описание
        <textarea
          aria-label="Описание задачи"
          value={task.description ?? ""}
          maxLength={100000}
          rows={4}
          onChange={(e) => update({ description: e.target.value })}
        />
      </label>
      <div className="form-pair">
        <label className="field-label">
          Приоритет
          <select
            aria-label="Приоритет задачи"
            value={task.priority ?? "none"}
            onChange={(e) =>
              update({ priority: e.target.value as typeof task.priority })
            }
          >
            <option value="none">Не задан</option>
            <option value="low">Низкий</option>
            <option value="normal">Обычный</option>
            <option value="high">Высокий</option>
            <option value="urgent">Срочный</option>
          </select>
        </label>
        <label className="field-label">
          Начало
          <input
            aria-label="Начало задачи"
            type="date"
            value={task.start ?? ""}
            max={task.due}
            onChange={(e) => update({ start: e.target.value || undefined })}
          />
        </label>
      </div>
      <div className="form-pair">
        <label className="field-label">
          Оценка, часы
          <input
            aria-label="Оценка задачи"
            type="number"
            min={0}
            max={1000000}
            step={0.5}
            value={task.estimate ?? ""}
            onChange={(e) =>
              update({
                estimate:
                  e.target.value === "" ? undefined : Number(e.target.value),
              })
            }
          />
        </label>
        <label className="field-label">
          Теги через запятую
          <ListInput
            label="Теги задачи"
            values={task.tags ?? []}
            separator=","
            maxLength={5000}
            onChange={(tags) => update({ tags: tags.slice(0, 50) })}
          />
        </label>
      </div>
      <label className="field-label">
        Зависит от задач
        <select
          aria-label="Зависимости задачи"
          multiple
          size={Math.min(
            4,
            Math.max(
              2,
              elements.filter((e) => e.kind === "task" && e.id !== element.id)
                .length,
            ),
          )}
          value={task.dependencies ?? []}
          onChange={(e) =>
            update({
              dependencies: Array.from(
                e.target.selectedOptions,
                (o) => o.value,
              ),
            })
          }
        >
          {elements
            .filter((e) => e.kind === "task" && e.id !== element.id)
            .map((e) => (
              <option key={e.id} value={e.id}>
                {e.text || "Задача без названия"}
              </option>
            ))}
          {(task.dependencies ?? [])
            .filter((id) => !elements.some((e) => e.id === id))
            .map((id) => (
              <option key={id} value={id}>
                Удалённая задача ({id.slice(0, 8)})
              </option>
            ))}
        </select>
      </label>
      <label className="data-checkbox">
        <input
          type="checkbox"
          aria-label="Задача в архиве"
          checked={!!task.archived}
          onChange={(e) => update({ archived: e.target.checked })}
        />
        В архиве
      </label>
      {task.start && task.due && task.start > task.due && (
        <p className="inline-error" role="status">
          Начало позже срока. Проверьте даты задачи.
        </p>
      )}
    </details>
  );
}
