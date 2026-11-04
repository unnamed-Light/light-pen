import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import type { BoardDocument } from "../editor/model/types";
import { pageElements, pagesOf } from "../editor/model/pages";
import { unionBounds } from "../editor/model/geometry";
import { captureExportSnapshot, planExport } from "../export/plan";
import { renderExportPreview } from "../export/generate";
import type {
  ExportFormat,
  ExportRequest,
  ExportSnapshot,
} from "../export/plan";
import type { ExportProgress } from "../export/generate";

/** board/slides retain compatibility with existing menu and MCP callers. */
export type ExportScope =
  "board" | "selection" | "slides" | "frame" | "region" | "pages" | "workspace";
const useStyles = makeStyles({
  surface: {
    width: "940px",
    maxWidth: "calc(100vw - 32px)",
    maxHeight: "calc(100vh - 32px)",
  },
  content: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1.15fr) minmax(245px, .85fr)",
    gap: "24px",
    overflowY: "auto",
    maxHeight: "calc(100vh - 190px)",
    "@media (max-width: 740px)": {
      gridTemplateColumns: "minmax(0, 1fr)",
      gap: "16px",
    },
  },
  previewColumn: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    minWidth: 0,
  },
  preview: {
    minHeight: "240px",
    height: "300px",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    borderRadius: tokens.borderRadiusMedium,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    backgroundColor: tokens.colorNeutralBackground3,
    backgroundImage: `repeating-conic-gradient(${tokens.colorNeutralBackground1} 0% 25%, ${tokens.colorNeutralBackground3} 0% 50%)`,
    backgroundSize: "20px 20px",
    "@media (max-width: 740px)": { minHeight: "140px", height: "180px" },
  },
  image: {
    display: "block",
    maxWidth: "100%",
    maxHeight: "100%",
    objectFit: "contain",
  },
  controls: {
    display: "flex",
    flexDirection: "column",
    gap: "14px",
    minWidth: 0,
  },
  label: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    fontSize: tokens.fontSizeBase300,
    fontWeight: tokens.fontWeightSemibold,
  },
  input: {
    color: tokens.colorNeutralForeground1,
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke1}`,
    borderRadius: tokens.borderRadiusMedium,
    minHeight: "32px",
    padding: "5px 8px",
    fontFamily: tokens.fontFamilyBase,
    fontSize: tokens.fontSizeBase300,
    width: "100%",
    boxSizing: "border-box",
    ":focus-visible": {
      outline: `2px solid ${tokens.colorStrokeFocus2}`,
      outlineOffset: "1px",
    },
  },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
    gap: "10px",
  },
  details: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: "12px",
    "& > summary": {
      cursor: "pointer",
      fontWeight: tokens.fontWeightSemibold,
      paddingBottom: "8px",
    },
  },
  advanced: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    paddingTop: "6px",
  },
  hint: {
    color: tokens.colorNeutralForeground3,
    fontSize: tokens.fontSizeBase200,
    lineHeight: tokens.lineHeightBase200,
    margin: 0,
  },
  dimensions: {
    fontSize: tokens.fontSizeBase400,
    fontWeight: tokens.fontWeightSemibold,
    margin: 0,
    fontVariantNumeric: "tabular-nums",
  },
  error: {
    color: tokens.colorPaletteRedForeground1,
    fontSize: tokens.fontSizeBase200,
    margin: 0,
    lineHeight: tokens.lineHeightBase300,
  },
  previewNavigation: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "6px",
  },
});

export function ExportDialog({
  document: board,
  activePageId,
  selectionIds,
  hasSelection,
  hasFrames,
  busy,
  progress,
  onClose,
  onCancel,
  onExport,
}: {
  document?: BoardDocument;
  activePageId?: string;
  selectionIds?: Iterable<string>;
  hasSelection: boolean;
  hasFrames: boolean;
  busy: boolean;
  progress?: ExportProgress;
  onClose: () => void;
  onCancel?: () => void;
  onExport: (
    format: ExportFormat,
    scope: ExportScope,
    request: ExportRequest,
    snapshot?: ExportSnapshot,
  ) => void;
}) {
  const styles = useStyles();
  const [snapshot] = useState(() =>
    board ? captureExportSnapshot(board, { activePageId, selectionIds }) : null,
  );
  const [format, setFormat] = useState<ExportFormat>("pdf");
  const [scope, setScope] = useState<ExportScope>(
    hasSelection ? "selection" : "board",
  );
  const [quality, setQuality] = useState("2");
  const [customAxis, setCustomAxis] = useState<"width" | "height">("width");
  const [customValue, setCustomValue] = useState("2000");
  const [transparent, setTransparent] = useState(false);
  const [padding, setPadding] = useState("24");
  const [columns, setColumns] = useState("");
  const [gap, setGap] = useState("48");
  const [pdfPageSize, setPdfPageSize] = useState<"content" | "a4" | "a3">(
    "content",
  );
  const [advanced, setAdvanced] = useState(false);
  const sourcePages = snapshot ? pagesOf(snapshot.document) : [];
  const activeElements = snapshot
    ? pageElements(snapshot.document, snapshot.activePageId)
    : [];
  const frames = activeElements.filter((e) => e.kind === "frame" && !e.hidden);
  const [frameId, setFrameId] = useState(frames[0]?.id ?? "");
  const [region, setRegion] = useState(() => {
    const b = unionBounds(activeElements.filter((e) => !e.hidden));
    return {
      x: String(Math.floor(b?.minX ?? 0)),
      y: String(Math.floor(b?.minY ?? 0)),
      width: String(Math.ceil(b ? b.maxX - b.minX : 800)),
      height: String(Math.ceil(b ? b.maxY - b.minY : 600)),
    };
  });
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPage, setPreviewPage] = useState(0);
  const raster = format === "png" || format === "zip";
  const request = useMemo<ExportRequest>(
    () => ({
      format,
      scope: scope === "board" ? "page" : scope === "slides" ? "frames" : scope,
      frameId: scope === "frame" ? frameId : undefined,
      region:
        scope === "region"
          ? {
              x: Number(region.x),
              y: Number(region.y),
              width: Number(region.width),
              height: Number(region.height),
            }
          : undefined,
      scale: quality === "custom" ? 1 : Number(quality),
      pixelWidth:
        raster && quality === "custom" && customAxis === "width"
          ? Number(customValue)
          : undefined,
      pixelHeight:
        raster && quality === "custom" && customAxis === "height"
          ? Number(customValue)
          : undefined,
      transparent: format !== "pdf" && transparent,
      padding: Number(padding),
      layout: {
        columns: columns ? Number(columns) : undefined,
        gap: Number(gap),
      },
      pdfPageSize,
    }),
    [
      format,
      scope,
      frameId,
      region,
      quality,
      raster,
      customAxis,
      customValue,
      transparent,
      padding,
      columns,
      gap,
      pdfPageSize,
    ],
  );
  const result = useMemo(() => {
    try {
      return snapshot
        ? { plan: planExport(snapshot, request), error: "" }
        : {
            plan: undefined,
            error: "Дождитесь открытия доски для расчёта размеров.",
          };
    } catch (error) {
      return {
        plan: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [snapshot, request]);
  const plan = result.plan;
  useEffect(() => {
    setPreviewPage(0);
  }, [scope, format]);
  useEffect(() => {
    if (!snapshot || !plan || busy) {
      setPreviewLoading(false);
      return;
    }
    const abort = new AbortController();
    let url = "";
    setPreviewLoading(true);
    setPreviewError("");
    const timer = setTimeout(() => {
      void renderExportPreview(snapshot, request, {
        maxSide: 560,
        pageIndex: previewPage,
        signal: abort.signal,
      })
        .then((result) => {
          if (abort.signal.aborted) return;
          url = URL.createObjectURL(result.blob);
          setPreviewUrl(url);
          setPreviewLoading(false);
        })
        .catch((error) => {
          if (abort.signal.aborted) return;
          setPreviewError(
            error instanceof Error ? error.message : String(error),
          );
          setPreviewLoading(false);
        });
    }, 180);
    return () => {
      clearTimeout(timer);
      abort.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [snapshot, request, plan, previewPage, busy]);
  const chooseScope = (value: ExportScope) => {
    setScope(value);
    if (value === "frame" || value === "region") setAdvanced(true);
  };
  const chooseFormat = (value: ExportFormat) => {
    setFormat(value);
    if (value === "svg" && ["slides", "workspace", "pages"].includes(scope))
      setScope("board");
  };
  const first = plan?.pages[0];
  const width = plan?.width ?? first?.pixelWidth;
  const height = plan?.height ?? first?.pixelHeight;
  const ratio = width && height ? width / height : 4 / 3;
  const customWidth =
    quality === "custom" && customAxis === "width"
      ? customValue
      : String(
          quality === "custom"
            ? Math.round(Number(customValue) * ratio)
            : (width ?? ""),
        );
  const customHeight =
    quality === "custom" && customAxis === "height"
      ? customValue
      : String(
          quality === "custom"
            ? Math.round(Number(customValue) / ratio)
            : (height ?? ""),
        );
  const error = result.error || previewError;
  const multi = !!plan && plan.pages.length > 1 && format !== "png";
  const dimensionText = !plan
    ? "Размер пока не рассчитан"
    : format === "pdf"
      ? `${plan.pages.length} стр. · ${Math.round(first!.pdfWidth)} × ${Math.round(first!.pdfHeight)} pt`
      : format === "zip"
        ? `${plan.pages.length} PNG · до ${plan.pages.reduce((n, p) => Math.max(n, p.pixelWidth), 0)} × ${plan.pages.reduce((n, p) => Math.max(n, p.pixelHeight), 0)} px`
        : `${width?.toLocaleString("ru-RU")} × ${height?.toLocaleString("ru-RU")} px`;
  const memory = plan
    ? `Оценка памяти: до ${Math.ceil(plan.estimatedWorkingBytes / 1024 / 1024)} MiB.`
    : "";
  const field = (
    label: string,
    value: string,
    change: (v: string) => void,
    minimum?: number,
  ) => (
    <label className={styles.label}>
      {label}
      <input
        className={styles.input}
        aria-label={label}
        type="number"
        value={value}
        min={minimum}
        disabled={busy}
        onChange={(e) => change(e.target.value)}
      />
    </label>
  );
  return (
    <Dialog
      open
      onOpenChange={(_, data) => {
        if (!data.open && !busy) onClose();
      }}
    >
      <DialogSurface className={styles.surface}>
        <DialogBody>
          <DialogTitle>Экспорт доски</DialogTitle>
          <DialogContent className={styles.content}>
            <div className={styles.previewColumn}>
              <div
                className={styles.preview}
                aria-label="Предпросмотр экспорта"
                aria-busy={previewLoading}
              >
                {previewUrl && !result.error ? (
                  <img
                    className={styles.image}
                    src={previewUrl}
                    alt="Предпросмотр выбранной области"
                  />
                ) : (
                  <span className={styles.hint}>
                    {result.error
                      ? "Измените параметры экспорта"
                      : "Подготовка предпросмотра…"}
                  </span>
                )}
              </div>
              <p className={styles.dimensions} data-testid="export-dimensions">
                {dimensionText}
              </p>
              {multi && (
                <div className={styles.previewNavigation}>
                  <Button
                    size="small"
                    disabled={previewPage === 0 || busy}
                    onClick={() => setPreviewPage((p) => p - 1)}
                    aria-label="Предыдущая страница предпросмотра"
                  >
                    Назад
                  </Button>
                  <span className={styles.hint}>
                    {previewPage + 1} / {plan!.pages.length}
                  </span>
                  <Button
                    size="small"
                    disabled={previewPage >= plan!.pages.length - 1 || busy}
                    onClick={() => setPreviewPage((p) => p + 1)}
                    aria-label="Следующая страница предпросмотра"
                  >
                    Далее
                  </Button>
                </div>
              )}
              <p className={styles.hint}>
                {memory} Скрытые объекты не экспортируются.
              </p>
              {error && (
                <p className={styles.error} role="alert">
                  {error}
                </p>
              )}
              {plan?.warnings.map((warning) => (
                <p className={styles.hint} key={warning}>
                  {warning}
                </p>
              ))}
              {busy && (
                <p className={styles.hint} role="status">
                  {progress
                    ? `${progress.phase === "packing" ? "Упаковка" : "Подготовка"}: ${progress.completed} из ${progress.total}`
                    : "Подготовка файла…"}
                </p>
              )}
            </div>
            <div className={styles.controls}>
              <label className={styles.label}>
                Формат
                <select
                  className={styles.input}
                  aria-label="Формат экспорта"
                  value={format}
                  disabled={busy}
                  onChange={(e) => chooseFormat(e.target.value as ExportFormat)}
                >
                  <option value="pdf">PDF — документ и страницы</option>
                  <option value="png">PNG — изображение</option>
                  <option value="zip">ZIP — отдельные PNG</option>
                  <option value="svg">SVG — векторное изображение</option>
                </select>
              </label>
              <label className={styles.label}>
                Область
                <select
                  className={styles.input}
                  aria-label="Область экспорта"
                  value={scope}
                  disabled={busy}
                  onChange={(e) => chooseScope(e.target.value as ExportScope)}
                >
                  <option value="board">Текущая страница</option>
                  <option value="selection" disabled={!hasSelection}>
                    Выделение
                  </option>
                  <option value="workspace" disabled={format === "svg"}>
                    {format === "png"
                      ? "Все страницы одной раскладкой"
                      : "Все страницы"}
                  </option>
                  <option
                    value="slides"
                    disabled={!hasFrames || format === "svg"}
                  >
                    {format === "pdf"
                      ? "Фреймы отдельными страницами"
                      : "Все фреймы текущей страницы"}
                  </option>
                  <option value="frame" disabled={!hasFrames}>
                    Один фрейм
                  </option>
                  <option value="region">Заданная область</option>
                </select>
              </label>
              {raster && (
                <label className={styles.label}>
                  Масштаб
                  <select
                    className={styles.input}
                    aria-label="Масштаб экспорта"
                    value={quality}
                    disabled={busy}
                    onChange={(e) => {
                      setQuality(e.target.value);
                      if (e.target.value === "custom") setAdvanced(true);
                    }}
                  >
                    <option value="1">1× — исходный размер</option>
                    <option value="2">2× — чётче</option>
                    <option value="4">4× — высокое разрешение</option>
                    <option value="custom">Точный размер в пикселях</option>
                  </select>
                </label>
              )}
              <details
                className={styles.details}
                open={advanced}
                onToggle={(e) => setAdvanced(e.currentTarget.open)}
              >
                <summary>Дополнительно</summary>
                <div className={styles.advanced}>
                  {raster && (
                    <div className={styles.row}>
                      {field(
                        "Ширина PNG, px",
                        customWidth,
                        (v) => {
                          setQuality("custom");
                          setCustomAxis("width");
                          setCustomValue(v);
                        },
                        1,
                      )}
                      {field(
                        "Высота PNG, px",
                        customHeight,
                        (v) => {
                          setQuality("custom");
                          setCustomAxis("height");
                          setCustomValue(v);
                        },
                        1,
                      )}
                    </div>
                  )}
                  {format !== "pdf" && (
                    <Checkbox
                      label="Прозрачный фон"
                      disabled={busy}
                      checked={transparent}
                      onChange={(_, data) =>
                        setTransparent(data.checked === true)
                      }
                    />
                  )}
                  {scope === "frame" && (
                    <label className={styles.label}>
                      Фрейм
                      <select
                        className={styles.input}
                        aria-label="Фрейм экспорта"
                        disabled={busy}
                        value={frameId}
                        onChange={(e) => setFrameId(e.target.value)}
                      >
                        {frames.map((f) => (
                          <option key={f.id} value={f.id}>
                            {f.text || f.name || "Фрейм"}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {scope === "region" && (
                    <>
                      <div className={styles.row}>
                        {field("Область: X", region.x, (x) =>
                          setRegion((r) => ({ ...r, x })),
                        )}
                        {field("Область: Y", region.y, (y) =>
                          setRegion((r) => ({ ...r, y })),
                        )}
                      </div>
                      <div className={styles.row}>
                        {field(
                          "Область: ширина",
                          region.width,
                          (width) => setRegion((r) => ({ ...r, width })),
                          1,
                        )}
                        {field(
                          "Область: высота",
                          region.height,
                          (height) => setRegion((r) => ({ ...r, height })),
                          1,
                        )}
                      </div>
                    </>
                  )}
                  {!["frame", "region"].includes(scope) &&
                    field("Отступ вокруг содержимого", padding, setPadding, 0)}
                  {scope === "workspace" && format === "png" && (
                    <div className={styles.row}>
                      {field(
                        "Колонки раскладки",
                        columns ||
                          String(Math.ceil(Math.sqrt(sourcePages.length))),
                        setColumns,
                        1,
                      )}
                      {field("Интервал страниц", gap, setGap, 0)}
                    </div>
                  )}
                  {format === "pdf" && (
                    <label className={styles.label}>
                      Размер листа
                      <select
                        className={styles.input}
                        aria-label="Размер листа PDF"
                        disabled={busy}
                        value={pdfPageSize}
                        onChange={(e) =>
                          setPdfPageSize(e.target.value as typeof pdfPageSize)
                        }
                      >
                        <option value="content">По содержимому</option>
                        <option value="a4">A4 — вписать в лист</option>
                        <option value="a3">A3 — вписать в лист</option>
                      </select>
                    </label>
                  )}
                  {raster && (
                    <p className={styles.hint}>
                      До 16 384 px по стороне и 64 Мп. Пропорции сохраняются;
                      разрешение автоматически не уменьшается.
                    </p>
                  )}
                </div>
              </details>
              <p className={styles.hint}>
                Содержимое зафиксировано при открытии экспорта. Предпросмотр
                уменьшен; файл получит рассчитанный размер.
              </p>
            </div>
          </DialogContent>
          <DialogActions>
            <Button
              disabled={busy && !onCancel}
              onClick={busy ? onCancel : onClose}
            >
              {busy ? "Отменить экспорт" : "Закрыть"}
            </Button>
            <Button
              appearance="primary"
              disabled={busy || !!error || !plan || previewLoading}
              onClick={() =>
                onExport(format, scope, request, snapshot ?? undefined)
              }
            >
              {busy ? "Подготовка…" : "Экспортировать"}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
