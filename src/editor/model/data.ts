import { isDate, uid } from "./types";
import type { SceneElement, TableGrid, TableColumn } from "./types";

/** Deterministic legacy identities let independent clients migrate the same file. */
export function gridOf(element: SceneElement): TableGrid {
  return (
    element.grid ?? {
      rows: (element.cells ?? [[""]]).map((_, i) => `r${i}`),
      columns: (element.cells?.[0] ?? [""]).map((_, i) => ({
        id: `c${i}`,
        type: "text",
      })),
    }
  );
}
export function insertTableRow(
  element: SceneElement,
  at: number,
): SceneElement {
  const cells = element.cells!,
    grid = gridOf(element);
  if (cells.length >= 100) throw new Error("Поддерживается до 100 строк.");
  at = Math.max(0, Math.min(cells.length, at));
  return {
    ...element,
    height: (element.height * (cells.length + 1)) / cells.length,
    cells: [
      ...cells.slice(0, at),
      Array(cells[0].length).fill(""),
      ...cells.slice(at),
    ],
    grid: {
      ...grid,
      rows: [...grid.rows.slice(0, at), uid(), ...grid.rows.slice(at)],
    },
  };
}
export function insertTableColumn(
  element: SceneElement,
  at: number,
): SceneElement {
  const cells = element.cells!,
    grid = gridOf(element),
    cols = cells[0].length;
  if (cols >= 50) throw new Error("Поддерживается до 50 столбцов.");
  at = Math.max(0, Math.min(cols, at));
  return {
    ...element,
    width: (element.width * (cols + 1)) / cols,
    cells: cells.map((row) => [...row.slice(0, at), "", ...row.slice(at)]),
    grid: {
      ...grid,
      columns: [
        ...grid.columns.slice(0, at),
        { id: uid(), type: "text" },
        ...grid.columns.slice(at),
      ],
    },
  };
}
export function deleteTableAxis(
  element: SceneElement,
  axis: "row" | "column",
  at: number,
): SceneElement {
  const cells = element.cells!,
    grid = gridOf(element);
  if (axis === "row") {
    if (cells.length <= 1) return element;
    return {
      ...element,
      cells: cells.filter((_, i) => i !== at),
      height: (element.height * (cells.length - 1)) / cells.length,
      grid: { ...grid, rows: grid.rows.filter((_, i) => i !== at) },
    };
  }
  if (grid.columns.length <= 1) return element;
  return {
    ...element,
    cells: cells.map((row) => row.filter((_, i) => i !== at)),
    width: (element.width * (grid.columns.length - 1)) / grid.columns.length,
    grid: { ...grid, columns: grid.columns.filter((_, i) => i !== at) },
  };
}
/** Pasted rectangles append identities; existing records keep theirs. */
export function replaceTableCells(
  element: SceneElement,
  cells: string[][],
): SceneElement {
  const old = element.cells!,
    grid = gridOf(element);
  return {
    ...element,
    cells,
    width: (element.width * cells[0].length) / old[0].length,
    height: (element.height * cells.length) / old.length,
    grid: {
      rows: cells.map((_, i) => grid.rows[i] ?? uid()),
      columns: cells[0].map(
        (_, i) => grid.columns[i] ?? { id: uid(), type: "text" },
      ),
    },
  };
}
export type CellValue = {
  value: string | number | boolean | null;
  error?: string;
};
export function typedValue(raw: string, column: TableColumn): CellValue {
  if (!raw.trim()) return { value: null };
  switch (column.type) {
    case "number": {
      const normalized = raw.trim().replace(",", ".");
      const n = Number(normalized);
      return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized) &&
        Number.isFinite(n)
        ? { value: n }
        : { value: raw, error: "Ожидается число" };
    }
    case "date":
      return isDate(raw)
        ? { value: raw }
        : { value: raw, error: "Дата в формате ГГГГ-ММ-ДД" };
    case "checkbox": {
      if (/^(true|1|да|✓)$/i.test(raw.trim())) return { value: true };
      if (/^(false|0|нет|✗)$/i.test(raw.trim())) return { value: false };
      return { value: raw, error: "Используйте да / нет" };
    }
    case "select":
      return !column.options?.length || column.options.includes(raw)
        ? { value: raw }
        : { value: raw, error: "Выберите значение из списка" };
    case "url": {
      try {
        const url = new URL(raw);
        if (
          ["http:", "https:"].includes(url.protocol) &&
          !url.username &&
          !url.password
        )
          return { value: raw };
      } catch {
        /* Retain invalid input so it can be repaired. */
      }
      return { value: raw, error: "Ожидается HTTP- или HTTPS-ссылка" };
    }
    default:
      return { value: raw };
  }
}
export interface DataQuery {
  column?: string;
  search?: string;
  sort?: "asc" | "desc";
  errorsOnly?: boolean;
}
export function queryRecords(element: SceneElement, query: DataQuery = {}) {
  const grid = gridOf(element),
    cells = element.cells!;
  const columnIndex = grid.columns.findIndex((c) => c.id === query.column);
  const records = cells.slice(1).map((row, i) => ({
    id: grid.rows[i + 1],
    index: i + 1,
    values: row.map((v, c) => typedValue(v, grid.columns[c])),
  }));
  const filtered = records.filter(
    (r) =>
      (!query.errorsOnly || r.values.some((v) => v.error)) &&
      (!query.search ||
        cells[r.index].some((v) =>
          v.toLocaleLowerCase().includes(query.search!.toLocaleLowerCase()),
        )),
  );
  if (query.sort && columnIndex >= 0)
    filtered.sort((a, b) => {
      const x = a.values[columnIndex].value,
        y = b.values[columnIndex].value;
      // Empty values remain at the end in either direction; ties keep stable source order.
      if (x === null || y === null)
        return x === y ? a.index - b.index : x === null ? 1 : -1;
      const order =
        typeof x === "number" && typeof y === "number"
          ? x - y
          : String(x).localeCompare(String(y), "ru", { numeric: true });
      return (query.sort === "desc" ? -order : order) || a.index - b.index;
    });
  return filtered;
}
export function columnSummary(element: SceneElement, column: number) {
  const values = queryRecords(element).map((r) => r.values[column]);
  const numbers = values
    .filter((v) => !v.error && typeof v.value === "number")
    .map((v) => v.value as number);
  return {
    count: values.filter((v) => v.value !== null).length,
    errors: values.filter((v) => v.error).length,
    sum: numbers.reduce((s, n) => s + n, 0),
    average: numbers.length
      ? numbers.reduce((s, n) => s + n, 0) / numbers.length
      : null,
  };
}
