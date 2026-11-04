import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Select,
  Slider,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { open as chooseFolder } from "@tauri-apps/plugin-dialog";
import { isTauri } from "@tauri-apps/api/core";
import type { PluginHost } from "../plugins/host";
import type {
  JSONValue,
  PanelField,
  Permission,
  PluginPanel,
} from "../plugins/types";
import { EXAMPLE_PLUGIN } from "../plugins/examples";
import { parsePackage } from "../plugins/validation";

const labels: Record<Permission, string> = {
  "board:read": "Читать текущую страницу",
  "board:write": "Изменять объекты и виджеты",
  storage: "Хранить настройки расширения",
  network: "Обращаться к выбранным сайтам",
  "files:read": "Читать файлы в выбранной папке",
  "files:write": "Записывать файлы в выбранной папке",
  process: "Запускать отдельную программу",
};
const useStyles = makeStyles({
  surface: {
    width: "min(940px, calc(100vw - 32px))",
    maxWidth: "940px",
    maxHeight: "calc(100vh - 32px)",
  },
  content: {
    display: "grid",
    gridTemplateColumns: "220px minmax(0, 1fr)",
    gap: tokens.spacingHorizontalXL,
    minHeight: "380px",
    maxHeight: "calc(100vh - 230px)",
    overflowY: "auto",
    "@media(max-width: 680px)": {
      gridTemplateColumns: "1fr",
      minHeight: "240px",
    },
  },
  list: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalXS,
    borderRight: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingRight: tokens.spacingHorizontalM,
    "@media(max-width: 680px)": {
      maxHeight: "150px",
      overflowY: "auto",
      borderRight: "none",
      borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
      paddingBottom: tokens.spacingVerticalS,
    },
  },
  detail: {
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
  },
  actions: {
    display: "flex",
    gap: tokens.spacingHorizontalS,
    flexWrap: "wrap",
  },
  description: {
    margin: 0,
    color: tokens.colorNeutralForeground2,
    lineHeight: "1.5",
  },
  section: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: tokens.spacingVerticalM,
  },
  fields: {
    display: "flex",
    flexDirection: "column",
    gap: tokens.spacingVerticalM,
    marginTop: tokens.spacingVerticalM,
  },
  number: {
    display: "grid",
    gridTemplateColumns: "minmax(0, 1fr) 82px",
    gap: tokens.spacingHorizontalS,
    alignItems: "center",
  },
  error: { color: tokens.colorPaletteRedForeground1, overflowWrap: "anywhere" },
  warning: {
    backgroundColor: tokens.colorPaletteYellowBackground1,
    color: tokens.colorPaletteYellowForeground2,
    padding: tokens.spacingHorizontalM,
    borderRadius: tokens.borderRadiusMedium,
    lineHeight: "1.5",
  },
  message: {
    color: tokens.colorNeutralForeground2,
    whiteSpace: "pre-wrap",
    maxHeight: "100px",
    overflow: "auto",
    margin: 0,
  },
});

export interface PluginManagerProps {
  host: PluginHost;
  open: boolean;
  onOpenChange(open: boolean): void;
  pluginId?: string;
}
export function PluginManager({
  host,
  open,
  onOpenChange,
  pluginId,
}: PluginManagerProps) {
  const styles = useStyles();
  useSyncExternalStore(host.subscribe, host.getSnapshot);
  const entries = host.list();
  const [selected, setSelected] = useState(pluginId ?? ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState("");
  const [permissions, setPermissions] = useState<Permission[]>([]),
    [folder, setFolder] = useState(""),
    [origins, setOrigins] = useState(""),
    [trustedProcess, setTrustedProcess] = useState(false);
  const [panelId, setPanelId] = useState(""),
    [values, setValues] = useState<Record<string, JSONValue>>({}),
    [jsonArgs, setJsonArgs] = useState("{}");
  const fileInput = useRef<HTMLInputElement>(null),
    operation = useRef<"install" | "update">("install");
  const entry = entries.find((e) => e.manifest.id === selected) ?? entries[0];
  const manifest = entry?.manifest;
  const panel = manifest?.panels?.find((p) => p.id === panelId);
  useEffect(() => {
    void host.ready.catch((e) =>
      setError(String(e instanceof Error ? e.message : e)),
    );
  }, [host]);
  useEffect(() => {
    if (pluginId) setSelected(pluginId);
  }, [pluginId, open]);
  useEffect(() => {
    setPermissions(
      entry?.enabled
        ? entry.grants.permissions
        : (manifest?.permissions.filter((p) =>
            ["board:read", "board:write", "storage"].includes(p),
          ) ?? []),
    );
    setFolder(entry?.grants.folder ?? "");
    setOrigins(entry?.grants.networkOrigins?.join("\n") ?? "");
    setTrustedProcess(false);
    setPanelId("");
    setValues({});
    setResult("");
    setError("");
  }, [manifest?.id, manifest?.version]);
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const openPanel = (panel: PluginPanel) => {
    setPanelId(panel.id);
    setValues(
      Object.fromEntries(
        panel.fields.map((f) => [
          f.id,
          f.default ??
            (f.kind === "boolean"
              ? false
              : f.kind === "number"
                ? (f.min ?? 0)
                : ""),
        ]),
      ),
    );
    setResult("");
  };
  const execute = async (command: string, args: JSONValue) => {
    host.message = "";
    const result = await host.invoke(manifest!.id + "/" + command, args);
    const created =
      result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      Array.isArray(result.created)
        ? result.created.length
        : null;
    setResult(
      created !== null
        ? `Готово. Создано объектов: ${created}`
        : typeof result === "string"
          ? result
          : "Команда выполнена",
    );
  };
  const field = (f: PanelField) => {
    const value = values[f.id],
      set = (v: JSONValue) => setValues((values) => ({ ...values, [f.id]: v }));
    if (f.kind === "boolean")
      return (
        <Checkbox
          key={f.id}
          label={f.label}
          checked={value === true}
          onChange={(_, d) => set(d.checked === true)}
        />
      );
    return (
      <Field key={f.id} label={f.label}>
        {f.kind === "number" ? (
          <div className={styles.number}>
            <Slider
              aria-label={f.label}
              min={f.min ?? 0}
              max={f.max ?? 100}
              value={Number(value ?? 0)}
              onChange={(_, d) => set(d.value)}
            />
            <Input
              aria-label={f.label + " — точное значение"}
              type="number"
              min={f.min}
              max={f.max}
              value={String(value ?? 0)}
              onChange={(_, d) => set(Number(d.value))}
            />
          </div>
        ) : f.kind === "select" ? (
          <Select
            aria-label={f.label}
            value={String(value ?? "")}
            onChange={(_, d) => set(d.value)}
          >
            {f.options?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        ) : f.kind === "color" ? (
          <div className={styles.number}>
            <Input
              aria-label={f.label + " HEX"}
              value={String(value ?? "#0f6cbd")}
              onChange={(_, d) => set(d.value)}
            />
            <input
              aria-label={f.label}
              type="color"
              value={
                /^#[a-f\d]{6}$/i.test(String(value)) ? String(value) : "#0f6cbd"
              }
              onChange={(e) => set(e.target.value)}
            />
          </div>
        ) : (
          <Input
            aria-label={f.label}
            value={String(value ?? "")}
            onChange={(_, d) => set(d.value)}
          />
        )}
      </Field>
    );
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(_, data) => {
        if (!busy) onOpenChange(data.open);
      }}
    >
      <DialogSurface className={"plugin-dialog " + styles.surface}>
        <DialogBody>
          <DialogTitle>Расширения</DialogTitle>
          <DialogContent className={styles.content}>
            <aside
              className={styles.list}
              aria-label="Установленные расширения"
            >
              <Button
                disabled={busy}
                onClick={() => {
                  operation.current = "install";
                  fileInput.current?.click();
                }}
              >
                Установить из файла…
              </Button>
              {!entries.some(
                (e) => e.manifest.id === EXAMPLE_PLUGIN.manifest.id,
              ) && (
                <Button
                  appearance="subtle"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const id = await host.install(EXAMPLE_PLUGIN);
                      setSelected(id);
                    })
                  }
                >
                  Добавить пример
                </Button>
              )}
              {entries.map((e) => (
                <Button
                  key={e.manifest.id}
                  appearance={
                    e.manifest.id === manifest?.id ? "secondary" : "subtle"
                  }
                  aria-pressed={e.manifest.id === manifest?.id}
                  onClick={() => setSelected(e.manifest.id)}
                >
                  {e.manifest.name}
                  {e.enabled ? " · включено" : ""}
                </Button>
              ))}
              <input
                ref={fileInput}
                hidden
                type="file"
                accept=".lightpen-plugin,.json,application/json"
                aria-label="Пакет расширения"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (!file) return;
                  void run(async () => {
                    if (file.size > 2 * 1024 * 1024)
                      throw Error("Пакет расширения превышает 2 МБ");
                    const bundle = parsePackage(await file.text());
                    if (operation.current === "update") {
                      if (bundle.manifest.id !== manifest?.id)
                        throw Error(
                          "Для обновления выберите пакет этого расширения",
                        );
                      await host.update(bundle);
                    } else await host.install(bundle);
                    setSelected(bundle.manifest.id);
                  });
                }}
              />
            </aside>
            <div className={styles.detail}>
              {!manifest || !entry ? (
                <>
                  <h3>Инструменты для вашей доски</h3>
                  <p className={styles.description}>
                    Добавьте локальное расширение или попробуйте пример со
                    стикерами и счётчиком. Сначала вы увидите его разрешения,
                    затем сможете включить.
                  </p>
                </>
              ) : (
                <>
                  <div>
                    <h3 style={{ margin: 0 }}>{manifest.name}</h3>
                    <span className={styles.description}>
                      Версия {manifest.version}
                      {manifest.author ? " · " + manifest.author : ""}
                    </span>
                  </div>
                  <p className={styles.description}>{manifest.description}</p>
                  <div className={styles.actions}>
                    {entry.enabled ? (
                      <Button
                        onClick={() => {
                          setError("");
                          void host
                            .disable(manifest.id)
                            .catch((e) =>
                              setError(
                                String(e instanceof Error ? e.message : e),
                              ),
                            );
                        }}
                      >
                        Выключить
                      </Button>
                    ) : (
                      <Button
                        appearance="primary"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            host.enable(manifest.id, {
                              permissions,
                              ...(folder ? { folder } : {}),
                              networkOrigins: origins
                                .split(/[\n,]/)
                                .map((v) => v.trim())
                                .filter(Boolean),
                            }),
                          )
                        }
                      >
                        Включить
                      </Button>
                    )}
                    <Button
                      disabled={busy}
                      onClick={() => {
                        operation.current = "update";
                        fileInput.current?.click();
                      }}
                    >
                      Обновить…
                    </Button>
                  </div>
                  <details
                    className={styles.section}
                    key={manifest.id + manifest.version}
                    open={!entry.enabled}
                  >
                    <summary>Разрешения</summary>
                    <div className={styles.fields}>
                      <p className={styles.description}>
                        Выберите доступ и нажмите «Включить». После обновления
                        разрешения нужно выдать заново. Доступ к сайтам и файлам
                        не включается автоматически после перезапуска.
                      </p>
                      {manifest.permissions.map((p) => (
                        <Checkbox
                          key={p}
                          label={labels[p]}
                          checked={permissions.includes(p)}
                          disabled={
                            entry.enabled ||
                            (!isTauri() && p.startsWith("files:"))
                          }
                          onChange={(_, d) =>
                            setPermissions((items) =>
                              d.checked
                                ? [...items, p]
                                : items.filter((v) => v !== p),
                            )
                          }
                        />
                      ))}
                      {permissions.includes("network") && (
                        <Field label="Разрешённые сайты — по одному адресу на строку">
                          <Textarea
                            aria-label="Разрешённые сайты"
                            value={origins}
                            placeholder="https://example.com"
                            disabled={entry.enabled}
                            onChange={(_, d) => setOrigins(d.value)}
                          />
                        </Field>
                      )}
                      {permissions.some((p) => p.startsWith("files:")) && (
                        <div>
                          <Button
                            disabled={entry.enabled || !isTauri()}
                            onClick={() =>
                              void run(async () => {
                                const selected = await chooseFolder({
                                  directory: true,
                                  multiple: false,
                                  title: "Папка для расширения",
                                });
                                if (typeof selected === "string")
                                  setFolder(selected);
                              })
                            }
                          >
                            Выбрать папку…
                          </Button>
                          <p className={styles.description}>
                            {folder || "Папка не выбрана"}
                          </p>
                        </div>
                      )}
                    </div>
                  </details>
                  {manifest.runtime === "process" && (
                    <details className={styles.section}>
                      <summary>Расширенный запуск программы</summary>
                      <p className={styles.warning}>
                        Программа получает права вашего пользователя Windows.
                        Она может читать и изменять файлы и выходить в сеть вне
                        выбранных разрешений. Запускайте только код, которому
                        доверяете. Пароли и токены приложения ей не передаются.
                      </p>
                      <p
                        className={styles.description}
                        style={{ overflowWrap: "anywhere" }}
                      >
                        {manifest.process?.executable}
                      </p>
                      <details>
                        <summary>Параметры запуска</summary>
                        <pre
                          style={{
                            whiteSpace: "pre-wrap",
                            overflowWrap: "anywhere",
                            fontSize: 11,
                          }}
                        >
                          {manifest.process?.args?.join("\n") ||
                            "Без параметров"}
                        </pre>
                      </details>
                      <Checkbox
                        label="Я доверяю программе и разрешаю её запуск"
                        checked={trustedProcess}
                        onChange={(_, d) =>
                          setTrustedProcess(d.checked === true)
                        }
                      />
                      <Button
                        disabled={
                          busy ||
                          !entry.enabled ||
                          !trustedProcess ||
                          entry.running
                        }
                        onClick={() =>
                          void run(() =>
                            host.startNative(manifest.id, trustedProcess),
                          )
                        }
                      >
                        Запустить программу
                      </Button>
                      <p className={styles.description}>
                        Один запуск выполняет одну команду. Ограничения
                        процесса: 256 МБ памяти и 10 секунд процессорного
                        времени.
                      </p>
                    </details>
                  )}
                  {entry.enabled && (
                    <div className={styles.section}>
                      <div className={styles.actions}>
                        {manifest.panels?.map((p) => (
                          <Button
                            key={p.id}
                            disabled={busy}
                            appearance={
                              panelId === p.id ? "secondary" : "subtle"
                            }
                            onClick={() => openPanel(p)}
                          >
                            {p.title}
                          </Button>
                        ))}
                      </div>
                      {panel && (
                        <div className={styles.fields}>
                          <p className={styles.description}>
                            {panel.description}
                          </p>
                          {panel.fields.map(field)}
                          <Button
                            appearance="primary"
                            disabled={
                              busy ||
                              (manifest.runtime === "process" && !entry.running)
                            }
                            onClick={() =>
                              void run(() => execute(panel.command, values))
                            }
                          >
                            Выполнить
                          </Button>
                          <Button
                            appearance="subtle"
                            onClick={() => setPanelId("")}
                          >
                            Свернуть панель
                          </Button>
                        </div>
                      )}
                      <div className={styles.fields}>
                        {manifest.commands
                          .filter(
                            (c) =>
                              !manifest.panels?.some((p) => p.command === c.id),
                          )
                          .map((c) => (
                            <Button
                              key={c.id}
                              disabled={
                                busy ||
                                (manifest.runtime === "process" &&
                                  !entry.running)
                              }
                              onClick={() =>
                                void run(() =>
                                  execute(
                                    c.id,
                                    JSON.parse(jsonArgs) as JSONValue,
                                  ),
                                )
                              }
                            >
                              {c.title}
                            </Button>
                          ))}
                      </div>
                    </div>
                  )}
                  <details className={styles.section}>
                    <summary>Дополнительно</summary>
                    <div className={styles.fields}>
                      <Field label="Параметры команд JSON">
                        <Textarea
                          aria-label="Параметры команд JSON"
                          value={jsonArgs}
                          onChange={(_, d) => setJsonArgs(d.value)}
                        />
                      </Field>
                      <Button
                        disabled={busy}
                        onClick={() => void run(() => host.remove(manifest.id))}
                      >
                        Удалить расширение
                      </Button>
                      <p className={styles.description}>
                        Сохранённые виджеты останутся на доске с текстом и
                        данными.
                      </p>
                    </div>
                  </details>
                </>
              )}
              {error && (
                <p role="alert" className={styles.error}>
                  {error}
                </p>
              )}
              {(result || host.message) && (
                <pre role="status" className={styles.message}>
                  {host.message || result}
                </pre>
              )}
            </div>
          </DialogContent>
          <DialogActions>
            <Button disabled={busy} onClick={() => onOpenChange(false)}>
              Закрыть
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
