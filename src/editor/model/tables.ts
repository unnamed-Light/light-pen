/** Excel/LibreOffice TSV, including quoted tabs, quotes and line breaks. */
export function parseTsv(source: string): string[][] {
  if (source.length > 2_000_000)
    throw new Error("Буфер таблицы превышает 2 МБ.");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === '"' && (quoted || cell === "")) {
      if (quoted && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (!quoted && (c === "\t" || c === "\n" || c === "\r")) {
      row.push(cell);
      cell = "";
      if (c !== "\t") {
        rows.push(row);
        row = [];
        if (c === "\r" && source[i + 1] === "\n") i++;
      }
    } else cell += c;
  }
  if (quoted) throw new Error("В таблице не закрыты кавычки.");
  row.push(cell);
  if (row.some(Boolean) || row.length > 1 || !rows.length) rows.push(row);
  const width = Math.max(...rows.map((r) => r.length));
  if (rows.length > 100 || width > 50)
    throw new Error("Поддерживается до 100 строк и 50 столбцов.");
  if (rows.some((r) => r.some((c) => c.length > 10000)))
    throw new Error("Ячейка содержит больше 10 000 символов.");
  return rows.map((r) => Array.from({ length: width }, (_, i) => r[i] ?? ""));
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
