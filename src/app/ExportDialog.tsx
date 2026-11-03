import { useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
} from "@fluentui/react-components";
export type ExportScope = "board" | "selection" | "slides";
export function ExportDialog({
  hasSelection,
  hasFrames,
  busy,
  onClose,
  onExport,
}: {
  hasSelection: boolean;
  hasFrames: boolean;
  busy: boolean;
  onClose: () => void;
  onExport: (format: "png" | "svg" | "pdf", scope: ExportScope) => void;
}) {
  const [format, setFormat] = useState<"png" | "svg" | "pdf">("pdf"),
    [scope, setScope] = useState<ExportScope>(
      hasSelection ? "selection" : "board",
    );
  return (
    <Dialog
      open
      onOpenChange={(_, d) => {
        if (!d.open) onClose();
      }}
    >
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Экспорт доски</DialogTitle>
          <DialogContent>
            <label className="field-label">
              Формат
              <select
                aria-label="Формат экспорта"
                value={format}
                onChange={(e) => {
                  const v = e.target.value as typeof format;
                  setFormat(v);
                  if (v !== "pdf" && scope === "slides") setScope("board");
                }}
              >
                <option value="pdf">PDF — документ и страницы</option>
                <option value="svg">SVG — векторное изображение</option>
                <option value="png">PNG — изображение</option>
              </select>
            </label>
            <label className="field-label">
              Область
              <select
                aria-label="Область экспорта"
                value={scope}
                onChange={(e) => setScope(e.target.value as ExportScope)}
              >
                <option value="board">Вся видимая доска</option>
                <option value="selection" disabled={!hasSelection}>
                  Выделение
                </option>
                <option
                  value="slides"
                  disabled={!hasFrames || format !== "pdf"}
                >
                  Фреймы отдельными страницами
                </option>
              </select>
            </label>
            <p className="panel-hint">
              {format === "pdf"
                ? "Текст с кириллицей, линии и формулы сохраняются в векторе. Порядок страниц задаётся в панели фреймов."
                : format === "svg"
                  ? "Самостоятельный файл со встроенными изображениями и шрифтами."
                  : "PNG подходит для быстрой отправки изображения."}{" "}
              Скрытые объекты не экспортируются.
            </p>
          </DialogContent>
          <DialogActions>
            <Button onClick={onClose}>Закрыть</Button>
            <Button
              appearance="primary"
              disabled={busy}
              onClick={() => onExport(format, scope)}
            >
              {busy ? "Подготовка…" : "Экспортировать"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
