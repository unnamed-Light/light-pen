import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
  Tooltip,
} from "@fluentui/react-components";
import { Sparkle20Regular } from "@fluentui/react-icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as choose } from "@tauri-apps/plugin-dialog";
import { native } from "../platform/native";
import type { AgentController, AgentGrant } from "../agent/controller";

type Access = {
  grant: AgentGrant | null;
  folder?: string;
  configuration?: { command: string; args: string[] };
};
export function AgentAccess({
  agent,
  ready,
}: {
  agent: AgentController;
  ready: boolean;
}) {
  const [open, setOpen] = useState(false),
    [access, setAccess] = useState<Access>({ grant: null }),
    [write, setWrite] = useState(true),
    [network, setNetwork] = useState(false),
    [folder, setFolder] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [last, setLast] = useState("");
  useEffect(() => {
    const fn = async () => {
      setOpen(true);
      return { opened: true };
    };
    agent.editor.services.set("agent_ui", fn);
    return () => {
      agent.editor.services.delete("agent_ui");
    };
  }, [agent]);
  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const offs: (() => void)[] = [];
    void (async () => {
      const off = await listen<{
        id: string;
        session: string;
        method: string;
        params: Record<string, any>;
      }>("agent-request", async ({ payload: p }) => {
        if (disposed || agent.grant?.session !== p.session) return;
        let result: unknown;
        try {
          result = await agent.rpc(p.method, p.params);
          setLast(agent.lastAction);
        } catch (e) {
          result = { error: e instanceof Error ? e.message : String(e) };
        }
        await invoke("agent_reply", {
          id: p.id,
          session: p.session,
          result,
        }).catch(() => {});
      });
      if (disposed) {
        off();
        return;
      }
      offs.push(off);
      const stop = await listen<{ session: string }>(
        "agent-disabled",
        ({ payload }) => {
          if (agent.grant?.session === payload.session) {
            agent.disable();
            setAccess({ grant: null });
          }
        },
      );
      if (disposed) {
        stop();
        return;
      }
      offs.push(stop);
      const enabled = await listen<Access>(
        "agent-enabled",
        ({ payload: value }) => {
          if (!disposed && value.grant) {
            agent.enable({ ...value.grant, folder: value.folder });
            setAccess(value);
          }
        },
      );
      if (disposed) {
        enabled();
        return;
      }
      offs.push(enabled);
      // A reloaded frontend has no receipt ledger: revoke the old session rather
      // than allowing retries to apply twice after a WebView restart.
      await invoke("agent_attach");
    })().catch((e) => {
      if (!disposed) setError(String(e));
    });
    return () => {
      disposed = true;
      offs.forEach((off) => off());
      agent.disable();
    };
  }, [agent]);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const enable = () =>
    run(async () => {
      if (!ready) throw Error("Дождитесь открытия доски");
      const value = native
        ? await invoke<Access>("agent_start", { write, folder, network })
        : {
            grant: {
              session: crypto.randomUUID(),
              write,
              files: false,
              network,
            },
          };
      if (!value.grant) throw Error("Не удалось включить доступ");
      agent.enable({ ...value.grant, folder: value.folder } as AgentGrant);
      setAccess(value);
    });
  const disable = () =>
    run(async () => {
      agent.disable();
      if (native) await invoke("agent_stop");
      setAccess({ grant: null });
    });
  return (
    <>
      {access.grant && (
        <Tooltip content="Доступ ИИ включён" relationship="label">
          <Button
            appearance="subtle"
            icon={<Sparkle20Regular />}
            aria-label="Доступ ИИ включён"
            onClick={() => setOpen(true)}
          />
        </Tooltip>
      )}
      <Dialog
        open={open}
        onOpenChange={(_, d) => {
          if (!busy) setOpen(d.open);
        }}
      >
        <DialogSurface className="agent-dialog">
          <DialogBody>
            <DialogTitle>Доступ ИИ</DialogTitle>
            <DialogContent>
              <p>
                Подключите внешнего помощника к Light Pen. Он сможет читать
                объекты и выполнять команды редактора. Доступ действует до
                отключения или закрытия приложения.
              </p>
              <div className="agent-access-status" role="status">
                <span
                  className={`agent-access-dot ${access.grant ? "active" : ""}`}
                />
                <strong>
                  {access.grant ? "Доступ включён" : "Доступ выключен"}
                </strong>
              </div>
              {error && (
                <p role="alert" className="error-text">
                  {error}
                </p>
              )}
              {!access.grant ? (
                <div className="agent-grants">
                  <Checkbox
                    label="Разрешить редактирование"
                    checked={write}
                    onChange={(_, d) => setWrite(d.checked === true)}
                  />
                  <Checkbox
                    label="Разрешить подключение общих досок и управление приглашениями"
                    checked={network}
                    onChange={(_, d) => setNetwork(d.checked === true)}
                  />
                  <p className="muted">
                    Без выбранной папки помощник работает с открытой доской, её
                    историей и библиотекой шаблонов. Для открытия других файлов, сохранения новых
                    копий и экспорта выберите папку.
                  </p>
                  <div className="agent-folder">
                    <Button
                      disabled={!native || busy}
                      onClick={() =>
                        void run(async () => {
                          const p = await choose({
                            directory: true,
                            multiple: false,
                            title: "Папка для работы ИИ",
                          });
                          if (typeof p === "string") setFolder(p);
                        })
                      }
                    >
                      Выбрать папку…
                    </Button>
                    {folder && (
                      <Button
                        appearance="subtle"
                        onClick={() => setFolder(null)}
                      >
                        Убрать
                      </Button>
                    )}
                  </div>
                  {folder && <p className="agent-path">{folder}</p>}
                </div>
              ) : (
                <>
                  <p>
                    {access.grant.write
                      ? "Чтение и редактирование"
                      : "Только чтение"}
                    {access.grant.network ? " · Общие доски разрешены" : ""}
                  </p>
                  {access.folder && (
                    <p className="agent-path">Файлы: {access.folder}</p>
                  )}
                  <details open>
                    <summary>Подключение помощника</summary>
                    <p>
                      Добавьте эту конфигурацию в приложение, поддерживающее
                      MCP. Light Pen должен оставаться открытым.
                    </p>
                    <textarea
                      aria-label="Конфигурация подключения ИИ"
                      readOnly
                      rows={9}
                      value={
                        access.configuration
                          ? JSON.stringify(
                              {
                                mcpServers: { light_pen: access.configuration },
                              },
                              null,
                              2,
                            )
                          : "В веб-превью доступен только тест команд. Для внешнего подключения запустите настольную сборку."
                      }
                      onFocus={(e) => e.target.select()}
                    />
                  </details>
                  {access.configuration && (
                    <details>
                      <summary>Codex: конфигурация TOML</summary>
                      <textarea
                        aria-label="Конфигурация Codex"
                        readOnly
                        rows={6}
                        value={
                          "[mcp_servers.light_pen]\ncommand = " +
                          JSON.stringify(access.configuration.command) +
                          "\nargs = " +
                          JSON.stringify(access.configuration.args) +
                          "\ntool_timeout_sec = 120\n"
                        }
                        onFocus={(e) => e.target.select()}
                      />
                    </details>
                  )}
                  {last && <p className="muted">Последняя команда: {last}</p>}
                  <p className="muted">
                    Изменения входят в обычную историю отмены. Пароли и
                    сохранённые токены помощнику не выдаются. Содержимое,
                    которое он читает, обрабатывается выбранным вами ИИ.
                  </p>
                </>
              )}
            </DialogContent>
            <DialogActions>
              {access.grant ? (
                <Button
                  appearance="secondary"
                  disabled={busy}
                  onClick={() => void disable()}
                >
                  Отключить доступ
                </Button>
              ) : (
                <Button
                  appearance="primary"
                  disabled={busy || !ready}
                  onClick={() => void enable()}
                >
                  Включить доступ
                </Button>
              )}
              <Button disabled={busy} onClick={() => setOpen(false)}>
                Закрыть
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
