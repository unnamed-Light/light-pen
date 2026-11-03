import { useState } from "react";
import {
  Button,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
} from "@fluentui/react-components";
import type { Editor } from "../editor/editor";
import { createDocument, uid, validateDocument } from "../editor/model/types";
import type { SceneElement } from "../editor/model/types";
import { parseTsv, pasteCells } from "../editor/model/tables";
import { chooseLocalLink, native, readDocument } from "../platform/native";
import { STATUS_TEXT } from "../editor/render/structured";
export function StructuredEditor({
  editor,
  element,
}: {
  editor: Editor;
  element: SceneElement;
}) {
  const [draft, setDraft] = useState(() => structuredClone(element)),
    [cell, setCell] = useState<[number, number]>([0, 0]),
    [error, setError] = useState(""),
    [working, setWorking] = useState(false),
    [targets, setTargets] = useState<SceneElement[]>(
      draft.link?.path ? [] : editor.elements.filter((e) => e.id !== draft.id),
    );
  const close = () => {
    editor.objectDraft = null;
    editor.emit("ui");
  };
  const isLink = draft.kind === "link" || editor.objectDraftMode === "link";
  const patch = (p: Partial<SceneElement>) => setDraft((d) => ({ ...d, ...p }));
  const save = () => {
    try {
      if (isLink && !draft.link?.path && !draft.link?.elementId)
        throw new Error("Выберите файл или объект, на который ведёт ссылка.");
      validateDocument({ ...createDocument(), elements: [draft] });
      editor.saveObjectDraft(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const cells = draft.cells ?? [[""]],
    rows = cells.length,
    cols = cells[0].length;
  const changeCells = (next: string[][]) =>
    patch({
      cells: next,
      width: (draft.width * Math.max(1, next[0].length)) / cols,
      height: (draft.height * Math.max(1, next.length)) / rows,
    });
  const change = (r: number, c: number, value: string) =>
    patch({
      cells: cells.map((row, i) =>
        i === r
          ? row.map((v, j) => (j === c ? value.slice(0, 10000) : v))
          : row,
      ),
    });
  const browse = async () => {
    setWorking(true);
    try {
      const path = await chooseLocalLink();
      if (path) {
        patch({
          link: { ...draft.link, path },
          text:
            draft.text === "Ссылка" ? path.split(/[\\/]/).at(-1) : draft.text,
        });
        setTargets(
          path.toLowerCase().endsWith(".lightpen")
            ? (await readDocument(path)).elements
            : [],
        );
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setWorking(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(_, d) => {
        if (!d.open) close();
      }}
    >
      <DialogSurface
        className={`structured-dialog ${!isLink && draft.kind === "table" ? "table-dialog" : ""}`}
      >
        <DialogBody>
          <DialogTitle>
            {isLink
              ? "Локальная ссылка"
              : draft.kind === "table"
                ? "Таблица"
                : draft.kind === "task"
                  ? "Карточка задачи"
                  : "Локальная ссылка"}
          </DialogTitle>
          <DialogContent>
            {(!isLink || draft.kind === "link") && (
              <label className="field-label">
                {draft.kind === "task" ? "Задача" : "Название"}
                <input
                  aria-label="Название объекта"
                  maxLength={250}
                  value={draft.text ?? ""}
                  onChange={(e) => patch({ text: e.target.value })}
                />
              </label>
            )}
            {!isLink && draft.kind === "table" && (
              <>
                <div className="table-actions">
                  <Button
                    size="small"
                    disabled={rows >= 100}
                    onClick={() =>
                      changeCells([
                        ...cells.slice(0, cell[0] + 1),
                        Array(cols).fill(""),
                        ...cells.slice(cell[0] + 1),
                      ])
                    }
                  >
                    + Строка
                  </Button>
                  <Button
                    size="small"
                    disabled={cols >= 50}
                    onClick={() =>
                      changeCells(
                        cells.map((r) => [
                          ...r.slice(0, cell[1] + 1),
                          "",
                          ...r.slice(cell[1] + 1),
                        ]),
                      )
                    }
                  >
                    + Столбец
                  </Button>
                  <Button
                    size="small"
                    disabled={rows <= 1}
                    onClick={() => {
                      changeCells(cells.filter((_, i) => i !== cell[0]));
                      setCell([Math.min(cell[0], rows - 2), cell[1]]);
                    }}
                  >
                    Удалить строку
                  </Button>
                  <Button
                    size="small"
                    disabled={cols <= 1}
                    onClick={() => {
                      changeCells(
                        cells.map((r) => r.filter((_, i) => i !== cell[1])),
                      );
                      setCell([cell[0], Math.min(cell[1], cols - 2)]);
                    }}
                  >
                    Удалить столбец
                  </Button>
                </div>
                <p className="panel-hint">
                  {rows} × {cols}. Выберите ячейку и вставьте диапазон из Excel.
                  Двойной щелчок по таблице снова откроет редактор.
                </p>
                <div
                  className="table-scroll"
                  onPaste={(e) => {
                    const text = e.clipboardData.getData("text/plain");
                    if (!text.includes("\t") && !text.includes("\n")) return;
                    e.preventDefault();
                    try {
                      const incoming = parseTsv(text);
                      changeCells(
                        pasteCells(cells, incoming, cell[0], cell[1]),
                      );
                      setError("");
                    } catch (err) {
                      setError(String(err));
                    }
                  }}
                >
                  <table className="editable-table">
                    <tbody>
                      {cells.map((row, r) => (
                        <tr key={r}>
                          {row.map((value, c) => (
                            <td
                              key={c}
                              className={r === 0 ? "table-header" : ""}
                            >
                              <textarea
                                aria-label={`Ячейка ${r + 1}, ${c + 1}`}
                                value={value}
                                maxLength={10000}
                                onFocus={() => setCell([r, c])}
                                onChange={(e) => change(r, c, e.target.value)}
                                onKeyDown={(e) => {
                                  if (
                                    e.key === "Tab" &&
                                    !e.shiftKey &&
                                    r === rows - 1 &&
                                    c === cols - 1 &&
                                    rows < 100
                                  ) {
                                    e.preventDefault();
                                    changeCells([
                                      ...cells,
                                      Array(cols).fill(""),
                                    ]);
                                    setCell([rows, 0]);
                                    requestAnimationFrame(() =>
                                      document
                                        .querySelector<HTMLTextAreaElement>(
                                          `textarea[aria-label="Ячейка ${rows + 1}, 1"]`,
                                        )
                                        ?.focus(),
                                    );
                                  }
                                }}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {!isLink && draft.kind === "task" && draft.task && (
              <>
                <div className="form-pair">
                  <label className="field-label">
                    Статус
                    <select
                      aria-label="Статус задачи"
                      value={draft.task.status}
                      onChange={(e) =>
                        patch({
                          task: {
                            ...draft.task!,
                            status: e.target.value as NonNullable<
                              SceneElement["task"]
                            >["status"],
                          },
                        })
                      }
                    >
                      {Object.entries(STATUS_TEXT).map(([v, s]) => (
                        <option value={v} key={v}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field-label">
                    Срок
                    <input
                      type="date"
                      aria-label="Срок задачи"
                      value={draft.task.due ?? ""}
                      onChange={(e) =>
                        patch({
                          task: {
                            ...draft.task!,
                            due: e.target.value || undefined,
                          },
                        })
                      }
                    />
                  </label>
                </div>
                <div className="task-items">
                  {draft.task.items.map((item, i) => (
                    <div className="task-edit-row" key={item.id}>
                      <input
                        type="checkbox"
                        aria-label={`Выполнено ${i + 1}`}
                        checked={item.done}
                        onChange={(e) =>
                          patch({
                            task: {
                              ...draft.task!,
                              items: draft.task!.items.map((v, j) =>
                                j === i ? { ...v, done: e.target.checked } : v,
                              ),
                            },
                          })
                        }
                      />
                      <input
                        aria-label={`Пункт ${i + 1}`}
                        value={item.text}
                        maxLength={10000}
                        onChange={(e) =>
                          patch({
                            task: {
                              ...draft.task!,
                              items: draft.task!.items.map((v, j) =>
                                j === i ? { ...v, text: e.target.value } : v,
                              ),
                            },
                          })
                        }
                      />
                      <Button
                        size="small"
                        appearance="subtle"
                        aria-label={`Удалить пункт ${i + 1}`}
                        onClick={() =>
                          patch({
                            task: {
                              ...draft.task!,
                              items: draft.task!.items.filter(
                                (_, j) => j !== i,
                              ),
                            },
                          })
                        }
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  size="small"
                  disabled={draft.task.items.length >= 100}
                  onClick={() =>
                    patch({
                      height: Math.max(
                        draft.height,
                        120 + (draft.task!.items.length + 1) * 30,
                      ),
                      task: {
                        ...draft.task!,
                        items: [
                          ...draft.task!.items,
                          { id: uid(), text: "", done: false },
                        ],
                      },
                    })
                  }
                >
                  Добавить пункт
                </Button>
              </>
            )}
            {isLink && (
              <>
                <label className="field-label">
                  Подпись
                  <input
                    aria-label="Подпись ссылки"
                    maxLength={250}
                    value={draft.link?.label ?? ""}
                    onChange={(e) =>
                      patch({
                        link: {
                          path: "",
                          ...draft.link,
                          label: e.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label className="field-label">
                  Файл
                  <input
                    aria-label="Путь ссылки"
                    maxLength={4096}
                    placeholder="Пусто — объект текущей доски"
                    value={draft.link?.path ?? ""}
                    onChange={(e) => {
                      patch({
                        link: {
                          path: e.target.value,
                          label: draft.link?.label,
                        },
                      });
                      setTargets(
                        e.target.value
                          ? []
                          : editor.elements.filter((v) => v.id !== draft.id),
                      );
                    }}
                  />
                </label>
                <Button
                  disabled={!native || working}
                  onClick={() => void browse()}
                >
                  Выбрать локальный файл…
                </Button>
                <label className="field-label">
                  Объект или фрейм
                  <select
                    aria-label="Объект назначения"
                    value={draft.link?.elementId ?? ""}
                    onChange={(e) =>
                      patch({
                        link: {
                          path: "",
                          ...draft.link,
                          elementId: e.target.value || undefined,
                        },
                      })
                    }
                  >
                    <option value="">Вся доска / файл</option>
                    {targets.slice(0, 500).map((e) => (
                      <option value={e.id} key={e.id}>
                        {e.name || e.text?.slice(0, 60) || e.kind}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field-label">
                  Идентификатор объекта
                  <input
                    aria-label="Идентификатор назначения"
                    maxLength={128}
                    value={draft.link?.elementId ?? ""}
                    onChange={(e) =>
                      patch({
                        link: {
                          path: "",
                          ...draft.link,
                          elementId: e.target.value || undefined,
                        },
                      })
                    }
                  />
                </label>
                <p className="panel-hint">
                  Ссылка открывается кнопкой в свойствах. Если файл переехал,
                  здесь можно выбрать его заново.
                </p>
              </>
            )}
            {!!error && (
              <p className="inline-error" role="alert">
                {error}
              </p>
            )}
          </DialogContent>
          <DialogActions>
            {isLink && draft.kind !== "link" && element.link && (
              <Button
                appearance="subtle"
                onClick={() =>
                  editor.saveObjectDraft({ ...element, link: undefined })
                }
              >
                Убрать ссылку
              </Button>
            )}
            <Button appearance="secondary" onClick={close}>
              Отмена
            </Button>
            <Button appearance="primary" disabled={working} onClick={save}>
              Применить
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
