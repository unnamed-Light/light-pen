import { useEffect, useRef, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Input,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  Popover,
  PopoverSurface,
  PopoverTrigger,
} from "@fluentui/react-components";
import {
  Add20Regular,
  ChevronDown16Regular,
  MoreHorizontal20Regular,
  Document20Regular,
  Pin16Regular,
  Search20Regular,
} from "@fluentui/react-icons";
import type { Editor } from "../editor/editor";
import { elementPage } from "../editor/model/pages";
import "./Pages.css";

/** One quiet entry point: page navigation, search and occasional management. */
export function Pages({
  editor,
  onError,
  disabled = false,
}: {
  editor: Editor;
  onError: (message: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [limit, setLimit] = useState(60);
  const [edit, setEdit] = useState<{
      id: string;
      title: string;
      remove?: boolean;
    } | null>(null),
    [transfer, setTransfer] = useState(false),
    [destination, setDestination] = useState(""),
    [copy, setCopy] = useState(false);
  const visible = useRef(false);
  const surface = useRef<HTMLDivElement>(null);
  visible.current = open;
  useEffect(() => {
    if (open && editor.agentPanel?.kind === "pages") surface.current?.focus();
  }, [open, editor]);
  const close = () => {
    visible.current = false;
    setOpen(false);
    if (editor.agentPanel?.kind === "pages") editor.agentPanel = null;
  };
  useEffect(() => {
    const show = async (a: Record<string, any>) => {
      visible.current = true;
      setOpen(true);
      setQuery(a.search ?? "");
      if (a.agent)
        editor.agentPanel = {
          kind: "pages",
          close: () => {
            visible.current = false;
            setOpen(false);
          },
          isOpen: () => visible.current,
        };
      return { opened: true };
    };
    editor.services.set("pages_ui", show);
    return () => {
      if (editor.services.get("pages_ui") === show)
        editor.services.delete("pages_ui");
    };
  }, [editor]);
  const run = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  };
  const search = query.trim().toLocaleLowerCase(),
    pageOrder = [...editor.pages].sort(
      (a, b) =>
        Number(editor.isPagePinned(b.id)) - Number(editor.isPagePinned(a.id)),
    );
  const matches = pageOrder.filter(
    (p) => !search || p.title.toLocaleLowerCase().includes(search),
  );
  const objects = search
    ? editor.document.elements.filter(
        (e) =>
          !e.hidden &&
          [
            e.text,
            e.name,
            e.label,
            e.link?.label,
            e.cells?.flat().join(" "),
            e.task?.description,
            ...(e.task?.items.map((i) => i.text) ?? []),
          ].some((v) => v?.toLocaleLowerCase().includes(search)),
      )
    : [];
  const actionsDisabled = disabled || editor.readOnly || editor.isInteracting;
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(_, d) => {
          if (d.open) setOpen(true);
          else close();
        }}
        positioning="below-start"
      >
        <PopoverTrigger disableButtonEnhancement>
          <Button
            disabled={disabled}
            appearance="subtle"
            className="page-trigger"
            icon={<Document20Regular />}
            iconPosition="before"
            aria-label={`Страницы: ${editor.activePage.title}`}
          >
            <span>{editor.activePage.title}</span>
            <ChevronDown16Regular />
          </Button>
        </PopoverTrigger>
        <PopoverSurface
          ref={surface}
          tabIndex={-1}
          className="pages-popover"
          aria-label="Страницы пространства"
        >
          <div className="pages-heading">
            <strong>Страницы</strong>
            <span>{editor.pages.length}</span>
          </div>
          <Input
            aria-label="Поиск по пространству"
            contentBefore={<Search20Regular />}
            placeholder="Найти страницу или текст"
            value={query}
            onChange={(_, d) => {
              setQuery(d.value);
              setLimit(60);
            }}
          />
          <div
            className="pages-list"
            role="navigation"
            aria-label="Список страниц"
          >
            {matches.slice(0, limit).map((p) => (
              <div
                className="pages-row"
                key={p.id}
                data-active={p.id === editor.activePageId}
              >
                <Button
                  appearance="transparent"
                  className="page-name"
                  aria-current={
                    p.id === editor.activePageId ? "page" : undefined
                  }
                  onClick={() =>
                    run(() => {
                      editor.switchPage(p.id);
                      close();
                    })
                  }
                >
                  {editor.isPagePinned(p.id) && <Pin16Regular />}
                  <span>{p.title}</span>
                </Button>
                <Menu>
                  <MenuTrigger disableButtonEnhancement>
                    <Button
                      size="small"
                      appearance="subtle"
                      icon={<MoreHorizontal20Regular />}
                      aria-label={`Действия страницы ${p.title}`}
                    />
                  </MenuTrigger>
                  <MenuPopover>
                    <MenuList>
                      <MenuItem
                        onClick={() =>
                          run(() =>
                            editor.pinPage(p.id, !editor.isPagePinned(p.id)),
                          )
                        }
                      >
                        {editor.isPagePinned(p.id) ? "Открепить" : "Закрепить"}
                      </MenuItem>
                      <MenuItem
                        disabled={actionsDisabled}
                        onClick={() => {
                          close();
                          setEdit({ id: p.id, title: p.title });
                        }}
                      >
                        Переименовать…
                      </MenuItem>
                      <MenuItem
                        disabled={actionsDisabled}
                        onClick={() =>
                          run(() => {
                            editor.duplicatePage(p.id);
                            close();
                          })
                        }
                      >
                        Дублировать
                      </MenuItem>
                      <MenuItem
                        disabled={
                          actionsDisabled || editor.pages[0].id === p.id
                        }
                        onClick={() =>
                          run(() =>
                            editor.reorderPage(
                              p.id,
                              editor.pages.findIndex((x) => x.id === p.id) - 1,
                            ),
                          )
                        }
                      >
                        Выше
                      </MenuItem>
                      <MenuItem
                        disabled={
                          actionsDisabled || editor.pages.at(-1)?.id === p.id
                        }
                        onClick={() =>
                          run(() =>
                            editor.reorderPage(
                              p.id,
                              editor.pages.findIndex((x) => x.id === p.id) + 1,
                            ),
                          )
                        }
                      >
                        Ниже
                      </MenuItem>
                      <MenuItem
                        disabled={actionsDisabled || editor.pages.length === 1}
                        onClick={() => {
                          close();
                          setEdit({ id: p.id, title: p.title, remove: true });
                        }}
                      >
                        Удалить…
                      </MenuItem>
                    </MenuList>
                  </MenuPopover>
                </Menu>
              </div>
            ))}
            {!!objects.length && (
              <div className="pages-section-label">
                Текст на доске · {objects.length}
              </div>
            )}
            {objects.slice(0, limit).map((e) => (
              <Button
                appearance="subtle"
                className="page-search-result"
                key={e.id}
                onClick={() =>
                  run(() => {
                    editor.focusElement(e.id);
                    close();
                  })
                }
              >
                <span>
                  {e.name ||
                    e.text ||
                    e.label ||
                    e.cells
                      ?.flat()
                      .find((v) => v.toLocaleLowerCase().includes(search)) ||
                    e.task?.description ||
                    e.kind}
                </span>
                <small>
                  {
                    editor.pages.find(
                      (p) => p.id === elementPage(editor.document, e),
                    )?.title
                  }
                </small>
              </Button>
            ))}
            {!matches.length && !objects.length && (
              <p className="pages-empty">Ничего не найдено</p>
            )}
            {(matches.length > limit || objects.length > limit) && (
              <Button
                appearance="subtle"
                onClick={() => setLimit((v) => v + 60)}
              >
                Показать ещё
              </Button>
            )}
          </div>
          <div className="pages-footer">
            <Button
              appearance="subtle"
              icon={<Add20Regular />}
              disabled={actionsDisabled}
              onClick={() =>
                run(() => {
                  editor.createPage();
                  close();
                })
              }
            >
              Новая страница
            </Button>
            {editor.selected.size > 0 && editor.pages.length > 1 && (
              <Button
                appearance="subtle"
                disabled={actionsDisabled}
                onClick={() => {
                  setDestination(
                    editor.pages.find((p) => p.id !== editor.activePageId)!.id,
                  );
                  setCopy(false);
                  setTransfer(true);
                  close();
                }}
              >
                Перенести выбранное…
              </Button>
            )}
          </div>
        </PopoverSurface>
      </Popover>
      {edit && (
        <Dialog
          open
          onOpenChange={(_, d) => {
            if (!d.open) setEdit(null);
          }}
        >
          <DialogSurface>
            <DialogBody>
              <DialogTitle>
                {edit.remove ? "Удалить страницу?" : "Название страницы"}
              </DialogTitle>
              <DialogContent>
                {edit.remove ? (
                  <p>
                    Страница «{edit.title}» и все её объекты будут удалены.
                    Действие можно отменить.
                  </p>
                ) : (
                  <Input
                    aria-label="Название страницы"
                    autoFocus
                    maxLength={250}
                    value={edit.title}
                    onChange={(_, d) => setEdit({ ...edit, title: d.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && edit.title.trim())
                        run(() => {
                          editor.renamePage(edit.id, edit.title);
                          setEdit(null);
                        });
                    }}
                  />
                )}
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setEdit(null)}>Отмена</Button>
                <Button
                  appearance="primary"
                  disabled={!edit.remove && !edit.title.trim()}
                  onClick={() =>
                    run(() => {
                      if (edit.remove) editor.deletePage(edit.id);
                      else editor.renamePage(edit.id, edit.title);
                      setEdit(null);
                    })
                  }
                >
                  {edit.remove ? "Удалить" : "Сохранить"}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
      {transfer && (
        <Dialog
          open
          onOpenChange={(_, d) => {
            if (!d.open) setTransfer(false);
          }}
        >
          <DialogSurface>
            <DialogBody>
              <DialogTitle>На другую страницу</DialogTitle>
              <DialogContent>
                <label className="field-label">
                  Страница
                  <select
                    aria-label="Страница назначения"
                    value={destination}
                    onChange={(e) => setDestination(e.target.value)}
                  >
                    {editor.pages
                      .filter((p) => p.id !== editor.activePageId)
                      .map((p) => (
                        <option value={p.id} key={p.id}>
                          {p.title}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="field-label">
                  <input
                    type="checkbox"
                    checked={copy}
                    onChange={(e) => setCopy(e.target.checked)}
                  />
                  Оставить копию на текущей странице
                </label>
                <p className="pages-empty">
                  Вместе с фреймом переносятся его объекты и внутренние связи.
                </p>
              </DialogContent>
              <DialogActions>
                <Button onClick={() => setTransfer(false)}>Отмена</Button>
                <Button
                  appearance="primary"
                  onClick={() =>
                    run(() => {
                      editor.transferElements(
                        [...editor.selected],
                        destination,
                        copy,
                      );
                      setTransfer(false);
                    })
                  }
                >
                  {copy ? "Скопировать" : "Перенести"}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </>
  );
}
