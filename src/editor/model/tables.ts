/** Bounded Excel/LibreOffice data, including escaped quotes and line breaks. */
function parseDelimited(source: string, separator: string): string[][] {
  if (source.length > 2_000_000)
    throw new Error("Буфер таблицы превышает 2 МБ.");
  source = source.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  const finishCell = () => {
    if (row.length >= 50) throw new Error("Поддерживается до 50 столбцов.");
    row.push(cell);
    cell = "";
    closed = false;
  };
  const finishRow = () => {
    if (rows.length >= 100) throw new Error("Поддерживается до 100 строк.");
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"' && (quoted || cell === "") && !closed) {
      if (quoted && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        if (quoted) closed = true;
        quoted = !quoted;
      }
    } else if (!quoted && (c === separator || c === "\n" || c === "\r")) {
      finishCell();
      if (c !== separator) {
        finishRow();
        if (c === "\r" && source[i + 1] === "\n") i++;
      }
    } else {
      if (closed)
        throw new Error("После закрывающей кавычки ожидается разделитель.");
      cell += c;
    }
    if (cell.length > 10000)
      throw new Error("Ячейка содержит больше 10 000 символов.");
  }
  if (quoted) throw new Error("В таблице не закрыты кавычки.");
  finishCell();
  if (row.some(Boolean) || row.length > 1 || !rows.length) finishRow();
  const width = rows.reduce((m, r) => Math.max(m, r.length), 1);
  return rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));
}
export function parseTsv(source: string): string[][] {
  return parseDelimited(source, "\t");
}
export function parseCsv(source: string): string[][] {
  let quoted = false,
    commas = 0,
    semicolons = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"') {
      if (quoted && source[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (c === "\r" || c === "\n") break;
      if (c === ",") commas++;
      if (c === ";") semicolons++;
    }
  }
  return parseDelimited(source, semicolons > commas ? ";" : ",");
}
export function toCsv(cells: string[][], spreadsheetSafe = true): string {
  return (
    "\uFEFF" +
    cells
      .map((row) =>
        row
          .map((value) => {
            // CSV has no type metadata; protect formula-like imported text in spreadsheets.
            if (
              spreadsheetSafe &&
              (/^[\s]*[=+@\t\r]/.test(value) ||
                (/^\s*-/.test(value) &&
                  !/^\s*-\d+(?:[.,]\d+)?(?:e[+-]?\d+)?\s*$/i.test(value)))
            )
              value = "'" + value;
            return '"' + value.replaceAll('"', '""') + '"';
          })
          .join(","),
      )
      .join("\r\n")
  );
}
export function pasteCells(
  target: string[][],
  incoming: string[][],
  row: number,
  col: number,
): string[][] {
  const height = Math.max(target.length, row + incoming.length),
    width = Math.max(target[0].length, col + incoming[0].length);
  if (height > 100 || width > 50)
    throw new Error("Вставка превысит 100 строк или 50 столбцов.");
  return Array.from({ length: height }, (_, r) =>
    Array.from(
      { length: width },
      (_, c) => incoming[r - row]?.[c - col] ?? target[r]?.[c] ?? "",
    ),
  );
}
