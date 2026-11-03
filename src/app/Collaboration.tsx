import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  Button,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
} from "@fluentui/react-components";
import { People20Regular } from "@fluentui/react-icons";
import type { Editor } from "../editor/editor";
import type { SaveCoordinator } from "../platform/persistence";
import {
  api,
  createRoom,
  RoomClient,
  parseInvitation,
  invitation,
  serviceUrl,
} from "../collaboration/client";
import { bindRoom } from "../collaboration/binding";
import type { Role } from "../collaboration/client";
import { credentialStore } from "../platform/credentials";
import type { SavedRoom, SavedAccount } from "../platform/credentials";
import { uid } from "../editor/model/types";

type Account = {
  server: string;
  token: string;
  user: { login: string; name: string };
};
type Room = { id: string; title: string; role: Role };
type NetworkGuard = () => void;
export function Collaboration({
  editor,
  saver,
  ready,
}: {
  editor: Editor;
  saver: SaveCoordinator;
  ready: boolean;
}) {
  const [open, setOpen] = useState(false),
    [server, setServer] = useState(
      () => localStorage.getItem("lightpen.service") ?? "",
    ),
    [tab, setTab] = useState("room"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [login, setLogin] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState(""),
    [account, setAccount] = useState<Account | null>(null),
    [rooms, setRooms] = useState<Room[]>([]);
  const [invite, setInvite] = useState(""),
    [created, setCreated] = useState(""),
    [role, setRole] = useState<"editor" | "viewer">("editor"),
    [hours, setHours] = useState(24),
    [member, setMember] = useState("");
  const [client, setClient] = useState<RoomClient | null>(null),
    [grants, setGrants] = useState<
      {
        id: string;
        label: string;
        role: string;
        revoked: number;
        expires: number;
      }[]
    >([]),
    [members, setMembers] = useState<
      { login: string; name: string; role: string }[]
    >([]);
  const [savedRooms, setSavedRooms] = useState<SavedRoom[]>([]),
    [savedAccounts, setSavedAccounts] = useState<SavedAccount[]>([]);
  const [forget, setForget] = useState<SavedRoom | null>(null);
  const refreshSaved = async (guard?: NetworkGuard) => {
    guard?.();
    const value = await credentialStore.read();
    guard?.();
    setSavedRooms(value.rooms);
    setSavedAccounts(value.accounts);
  };
  const remember = async (fn: () => Promise<void>, guard?: NetworkGuard) => {
    guard?.();
    try {
      await fn();
      guard?.();
      await refreshSaved(guard);
      guard?.();
      return true;
    } catch (e) {
      guard?.();
      setError(
        "Не удалось сохранить доступ на этом компьютере. Для аккаунта понадобится повторный вход; гостевое приглашение сохраните отдельно. " +
          String(e instanceof Error ? e.message : e),
      );
      return false;
    }
  };
  useEffect(() => {
    if (ready) void refreshSaved().catch((e) => setError(String(e)));
  }, [ready]);
  const binding = useRef<ReturnType<typeof bindRoom> | null>(null),
    active = useRef<RoomClient | null>(null);
  useSyncExternalStore(
    client?.subscribe ?? (() => () => {}),
    client?.getSnapshot ?? (() => 0),
  );
  useSyncExternalStore(
    client ? editor.subscribeCamera : () => () => {},
    editor.getCameraSnapshot,
  );
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };
  const flush = async (guard?: NetworkGuard) => {
    guard?.();
    editor.commitText();
    editor.endStyle();
    editor.cancelGesture();
    await saver.flush();
    guard?.();
  };
  const detach = async (guard?: NetworkGuard) => {
    guard?.();
    const previous = binding.current;
    binding.current = null;
    active.current = null;
    setClient(null);
    await previous?.close();
    guard?.();
  };
  const connect = async (
    service: string,
    id: string,
    token: string,
    expected?: { id: string; revision: number },
    guard?: NetworkGuard,
  ) => {
    guard?.();
    const next = new RoomClient(service, id, token);
    try {
      await next.connect();
      guard?.();
      if (next.accessKind === "account") {
        const { user } = await api(next.server, "/v1/me", "GET", next.token);
        guard?.();
        setAccount({ server: next.server, token: next.token, user });
        await remember(
          () =>
            credentialStore.rememberAccount({
              server: next.server,
              token: next.token,
              login: user.login,
              name: user.name,
            }),
          guard,
        );
        guard?.();
      }
      const remembered = await remember(
        () =>
          credentialStore.rememberRoom({
            server: next.server,
            room: next.room,
            token: next.token,
            title: next.snapshot().title,
            role: next.role,
            accessedAt: Date.now(),
          }),
        guard,
      );
      guard?.();
      await flush(guard);
      guard?.();
      if (
        expected &&
        (editor.document.id !== expected.id ||
          editor.document.revision !== expected.revision)
      )
        throw Error("REVISION_CONFLICT: board changed while connecting");
      await detach(guard);
      guard?.();
      saver.reset(null);
      // Binding replaces the document synchronously. The original revision
      // guard must run immediately before it, never after that replacement.
      guard?.();
      binding.current = bindRoom(editor, next);
      active.current = next;
      setClient(next);
      saver.schedule(editor.document);
      setCreated("");
      setOpen(!remembered);
    } catch (e) {
      await next.close().catch(() => {});
      throw e;
    }
  };
  const refresh = async (c = active.current, guard?: NetworkGuard) => {
    guard?.();
    if (!c || c.role !== "owner") return;
    const [g, m] = await Promise.all([
      api(c.server, `/v1/rooms/${c.room}/invites`, "GET", c.token),
      api(c.server, `/v1/rooms/${c.room}/members`, "GET", c.token),
    ]);
    guard?.();
    setGrants(g.invites);
    setMembers(m.members);
  };
  useEffect(() => {
    if (open && client?.role === "owner")
      void refresh().catch((e) => setError(String(e)));
  }, [open, client]);
  useEffect(() => {
    let previous = "";
    const timer = setInterval(() => {
      const c = active.current;
      if (!c) return;
      if (editor.document.id !== c.room) {
        active.current = null;
        binding.current = null;
        setClient(null);
        return;
      }
      const cursor = editor.pointer
          ? {
              x: (editor.pointer.x - editor.camera.x) / editor.camera.zoom,
              y: (editor.pointer.y - editor.camera.y) / editor.camera.zoom,
            }
          : null,
        selected = [...editor.selected],
        packet = JSON.stringify([c.room, c.status, cursor, selected]);
      if (packet !== previous) {
        previous = packet;
        c.presence(cursor, selected);
      }
    }, 100);
    return () => {
      clearInterval(timer);
      void binding.current?.close().catch(() => {});
    };
  }, [editor]);
  const sign = async (register: boolean) => {
    const url = serviceUrl(server),
      data = await api(
        url,
        register ? "/v1/register" : "/v1/login",
        "POST",
        "",
        { login, password, name },
      );
    setPassword("");
    setAccount({ server: url, ...data });
    await remember(() =>
      credentialStore.rememberAccount({
        server: url,
        token: data.token,
        login: data.user.login,
        name: data.user.name,
      }),
    );
    localStorage.setItem("lightpen.service", url);
    setRooms((await api(url, "/v1/rooms", "GET", data.token)).rooms);
  };
  const disconnect = async (guard?: NetworkGuard) => {
    await flush(guard);
    guard?.();
    await detach(guard);
    guard?.();
    const now = new Date().toISOString(),
      camera = { ...editor.camera };
    editor.setDocument({
      ...editor.document,
      id: uid(),
      title: (editor.document.title.slice(0, 230) + " — локальная копия").slice(
        0,
        250,
      ),
      revision: 0,
      createdAt: now,
      updatedAt: now,
    });
    editor.setCamera(camera);
    saver.reset(null);
    saver.schedule(editor.document);
    setCreated("");
  };
  useEffect(() => {
    const fn = async (a: Record<string, any>) => {
      if (busy || !ready) throw Error("BUSY: collaboration is not ready");
      const c = active.current,
        expected = {
          id: a.documentId,
          revision: a.expectedRevision,
        };
      const guard = () => {
        if (!editor.assertAgentNetwork) throw Error("ACCESS_REVOKED");
        editor.assertAgentNetwork({
          session: a.session,
          documentId: a.documentId,
          expectedRevision: a.expectedRevision,
        });
      };
      const saved = () => credentialStore.read();
      const owner = () => {
        if (!c || c.role !== "owner") throw Error("OWNER_REQUIRED");
        return c;
      };
      const currentAccount = () => {
        if (!account) throw Error("ACCOUNT_REQUIRED: sign in using the app");
        return account;
      };
      switch (a.action) {
        case "status":
          return c
            ? {
                connected: true,
                server: c.server,
                room: c.room,
                role: c.role,
                status: c.status,
                unconfirmed: c.unconfirmed,
                peers: [...c.peers.values()],
              }
            : {
                connected: false,
                account: account
                  ? { server: account.server, ...account.user }
                  : null,
              };
        case "saved": {
          const s = await saved();
          return {
            accounts: s.accounts.map(({ token, ...rest }) => rest),
            rooms: s.rooms.map(({ token, ...rest }) => rest),
          };
        }
        case "show_account":
          setTab("account");
          setOpen(true);
          return { requiresUserInput: !account };
        case "resume_account": {
          guard();
          const s = (await saved()).accounts.find(
            (x) =>
              x.server === serviceUrl(a.server ?? server) &&
              (!a.login || x.login === a.login),
          );
          guard();
          if (!s) throw Error("Saved account not found");
          const { user } = await api(s.server, "/v1/me", "GET", s.token);
          guard();
          setAccount({ server: s.server, token: s.token, user });
          setServer(s.server);
          return { server: s.server, user };
        }
        case "logout": {
          guard();
          const ac = currentAccount();
          await api(ac.server, "/v1/logout", "POST", ac.token);
          guard();
          await credentialStore.forgetAccount(ac.server);
          guard();
          setAccount(null);
          setRooms([]);
          return { loggedOut: true };
        }
        case "list_rooms": {
          const ac = currentAccount();
          return api(ac.server, "/v1/rooms", "GET", ac.token);
        }
        case "create": {
          await flush(guard);
          guard();
          const url = serviceUrl(a.server ?? server);
          const r = await createRoom(
            url,
            editor.document,
            account?.server === url ? account.token : "",
          );
          guard();
          await credentialStore.rememberRoom({
            server: url,
            room: r.id,
            token: r.token,
            title: editor.document.title,
            role: r.role,
            accessedAt: Date.now(),
          });
          guard();
          setServer(url);
          localStorage.setItem("lightpen.service", url);
          await connect(url, r.id, r.token, expected, guard);
          return { room: r.id, role: r.role, server: url };
        }
        case "join": {
          const invitation = parseInvitation(a.invitation ?? "");
          await connect(
            invitation.service,
            invitation.room,
            invitation.token,
            expected,
            guard,
          );
          return { connected: true };
        }
        case "reopen": {
          guard();
          const url = serviceUrl(a.server ?? server),
            r = (await saved()).rooms.find(
              (r) => r.server === url && r.room === a.room,
            );
          guard();
          if (!r) throw Error("Saved room not found");
          await connect(r.server, r.room, r.token, expected, guard);
          return { connected: true };
        }
        case "forget_room": {
          const url = serviceUrl(a.server ?? server);
          if (!a.room) throw Error("room required");
          await credentialStore.forgetRoom(url, a.room);
          await refreshSaved();
          return { forgotten: a.room };
        }
        case "disconnect":
          if (!c) throw Error("NOT_CONNECTED");
          await disconnect(guard);
          return { localId: editor.document.id };
        case "list_access": {
          const c = owner();
          const [invites, members] = await Promise.all([
            api(c.server, `/v1/rooms/${c.room}/invites`, "GET", c.token),
            api(c.server, `/v1/rooms/${c.room}/members`, "GET", c.token),
          ]);
          return { invites: invites.invites, members: members.members };
        }
        case "invite": {
          guard();
          const c = owner();
          const g = await api(
            c.server,
            `/v1/rooms/${c.room}/invites`,
            "POST",
            c.token,
            {
              role: a.role ?? "editor",
              hours: a.hours ?? 24,
              label: a.label ?? "",
            },
          );
          guard();
          await refresh(c, guard);
          guard();
          return {
            id: g.id,
            invitation: invitation(c.server, c.room, g.token),
          };
        }
        case "revoke": {
          guard();
          const c = owner();
          if (!a.id) throw Error("id required");
          await api(
            c.server,
            `/v1/rooms/${c.room}/invites/${encodeURIComponent(a.id)}`,
            "DELETE",
            c.token,
          );
          guard();
          await refresh(c, guard);
          guard();
          return { revoked: a.id };
        }
        case "member": {
          guard();
          const c = owner();
          if (!a.login) throw Error("login required");
          await api(c.server, `/v1/rooms/${c.room}/members`, "POST", c.token, {
            login: a.login,
            role: a.role ?? "editor",
          });
          guard();
          await refresh(c, guard);
          guard();
          return { login: a.login };
        }
        case "remove_member": {
          guard();
          const c = owner();
          if (!a.login) throw Error("login required");
          await api(
            c.server,
            `/v1/rooms/${c.room}/members/${encodeURIComponent(a.login)}`,
            "DELETE",
            c.token,
          );
          guard();
          await refresh(c, guard);
          guard();
          return { removed: a.login };
        }
        case "claim": {
          guard();
          const c = owner(),
            ac = currentAccount();
          if (ac.server !== c.server)
            throw Error("Account belongs to another service");
          await api(c.server, `/v1/rooms/${c.room}/claim`, "POST", c.token, {
            accountToken: ac.token,
          });
          guard();
          await connect(c.server, c.room, ac.token, expected, guard);
          return { claimed: true };
        }
      }
      throw Error("Unknown collaboration action");
    };
    editor.services.set("collaboration", fn);
    return () => {
      editor.services.delete("collaboration");
    };
  });
  const state = client
    ? client.status === "online"
      ? client.unconfirmed
        ? "Отправка изменений"
        : "Общая доска"
      : client.status === "connecting"
        ? "Подключение…"
        : client.status === "offline"
          ? "Офлайн · правки на устройстве"
          : client.status === "revoked"
            ? "Доступ отозван"
            : "Ошибка связи"
    : "Совместная работа";
  return (
    <>
      <Button
        appearance={client ? "secondary" : "subtle"}
        icon={<People20Regular />}
        aria-label="Совместная работа"
        disabled={!ready}
        onClick={() => setOpen(true)}
        className="collaboration-trigger"
      >
        {client ? state : null}
      </Button>
      {client &&
        document.querySelector(".canvas-host") &&
        createPortal(
          <div className="collaborator-cursors" aria-hidden="true">
            {[...client.peers.values()]
              .filter((p) => p.cursor)
              .map((p, i) => (
                <div
                  key={p.id}
                  className="collaborator-cursor"
                  style={{
                    left: p.cursor!.x * editor.camera.zoom + editor.camera.x,
                    top: p.cursor!.y * editor.camera.zoom + editor.camera.y,
                    borderColor: ["#7f52c5", "#0e7870", "#da6b12"][i % 3],
                  }}
                >
                  <span>{p.name}</span>
                </div>
              ))}
          </div>,
          document.querySelector(".canvas-host")!,
        )}
      <Dialog
        open={open}
        onOpenChange={(_, d) => {
          if (!busy) setOpen(d.open);
        }}
      >
        <DialogSurface className="collaboration-dialog">
          <DialogBody>
            <DialogTitle>Совместная работа</DialogTitle>
            <DialogContent>
              <div className="collaboration-tabs">
                <Button
                  appearance={tab === "room" ? "primary" : "subtle"}
                  onClick={() => setTab("room")}
                >
                  Доска
                </Button>
                <Button
                  appearance={tab === "account" ? "primary" : "subtle"}
                  onClick={() => setTab("account")}
                >
                  {account ? account.user.name : "Аккаунт"}
                </Button>
              </div>
              {error && (
                <p role="alert" className="error-text">
                  {error}
                </p>
              )}
              {client?.error && <p role="status">{client.error}</p>}
              {tab === "account" ? (
                <>
                  {account ? (
                    <>
                      <p>
                        Вы вошли как <strong>{account.user.login}</strong>
                      </p>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            setRooms(
                              (
                                await api(
                                  account.server,
                                  "/v1/rooms",
                                  "GET",
                                  account.token,
                                )
                              ).rooms,
                            );
                          })
                        }
                      >
                        Обновить мои доски
                      </Button>
                      <div className="shared-room-list">
                        {rooms.map((r) => (
                          <Button
                            key={r.id}
                            disabled={busy}
                            onClick={() =>
                              void run(() =>
                                connect(account.server, r.id, account.token),
                              )
                            }
                          >
                            {r.title} ·{" "}
                            {r.role === "owner"
                              ? "Владелец"
                              : r.role === "editor"
                                ? "Редактор"
                                : "Просмотр"}
                          </Button>
                        ))}
                      </div>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await api(
                              account.server,
                              "/v1/logout",
                              "POST",
                              account.token,
                            );
                            setAccount(null);
                            setRooms([]);
                            await remember(() =>
                              credentialStore.forgetAccount(account.server),
                            );
                          })
                        }
                      >
                        Выйти из аккаунта
                      </Button>
                    </>
                  ) : (
                    <>
                      {savedAccounts
                        .filter((a) => a.server === server)
                        .map((a) => (
                          <Button
                            key={a.server}
                            disabled={busy}
                            onClick={() =>
                              void run(async () => {
                                const data = await api(
                                  a.server,
                                  "/v1/me",
                                  "GET",
                                  a.token,
                                );
                                setAccount({
                                  server: a.server,
                                  token: a.token,
                                  user: data.user,
                                });
                                setRooms(
                                  (
                                    await api(
                                      a.server,
                                      "/v1/rooms",
                                      "GET",
                                      a.token,
                                    )
                                  ).rooms,
                                );
                              })
                            }
                          >
                            Продолжить как {a.name || a.login}
                          </Button>
                        ))}
                      <label className="field-label">
                        Адрес сервиса
                        <input
                          aria-label="Адрес сервиса"
                          value={server}
                          onChange={(e) => setServer(e.target.value)}
                          placeholder="https://boards.example.org"
                        />
                      </label>
                      <label className="field-label">
                        Логин
                        <input
                          autoComplete="username"
                          value={login}
                          onChange={(e) => setLogin(e.target.value)}
                          maxLength={64}
                        />
                      </label>
                      <label className="field-label">
                        Пароль
                        <input
                          type="password"
                          autoComplete="current-password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          maxLength={256}
                        />
                      </label>
                      <label className="field-label">
                        Имя для участников
                        <input
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          maxLength={80}
                        />
                      </label>
                      <div className="table-actions">
                        <Button
                          disabled={busy}
                          appearance="primary"
                          onClick={() => void run(() => sign(false))}
                        >
                          Войти
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() => void run(() => sign(true))}
                        >
                          Создать аккаунт
                        </Button>
                      </div>
                    </>
                  )}
                </>
              ) : client ? (
                <>
                  <p>
                    <strong>{state}</strong> ·{" "}
                    {client.role === "owner"
                      ? "Владелец"
                      : client.role === "editor"
                        ? "Редактор"
                        : "Только просмотр"}
                  </p>
                  <p className="panel-hint">
                    На устройстве сохраняется локальная копия. Подтверждённая
                    сервером версия: {client.version}. Участников:{" "}
                    {client.peers.size + 1}.
                  </p>
                  <ul className="peer-list">
                    {[...client.peers.values()].map((p) => (
                      <li key={p.id}>
                        {p.name} ·{" "}
                        {p.role === "viewer" ? "Просмотр" : "Редактирование"}
                      </li>
                    ))}
                  </ul>
                  {client.role === "owner" && (
                    <>
                      <label className="field-label">
                        Доступ по приглашению
                        <select
                          value={role}
                          onChange={(e) =>
                            setRole(e.target.value as typeof role)
                          }
                        >
                          <option value="editor">Редактирование</option>
                          <option value="viewer">Только просмотр</option>
                        </select>
                      </label>
                      <label className="field-label">
                        Срок в часах
                        <input
                          type="number"
                          min={1}
                          max={720}
                          value={hours}
                          onChange={(e) => setHours(Number(e.target.value))}
                        />
                      </label>
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const g = await api(
                              client.server,
                              `/v1/rooms/${client.room}/invites`,
                              "POST",
                              client.token,
                              { role, hours },
                            );
                            setCreated(
                              invitation(client.server, client.room, g.token),
                            );
                            await refresh();
                          })
                        }
                      >
                        Создать приглашение
                      </Button>
                      {created && (
                        <label className="field-label">
                          Передайте приглашение участнику
                          <textarea
                            aria-label="Готовое приглашение"
                            value={created}
                            readOnly
                            rows={4}
                          />
                          <Button
                            onClick={() =>
                              void run(() =>
                                navigator.clipboard.writeText(created),
                              )
                            }
                          >
                            Копировать приглашение
                          </Button>
                        </label>
                      )}
                      <details>
                        <summary>Выданный доступ</summary>
                        {grants
                          .filter((g) => !g.revoked)
                          .map((g) => (
                            <div className="shared-access-row" key={g.id}>
                              <span>
                                {g.label} ·{" "}
                                {g.role === "editor" ? "Редактор" : "Просмотр"}
                              </span>
                              <Button
                                disabled={busy}
                                onClick={() =>
                                  void run(async () => {
                                    await api(
                                      client.server,
                                      `/v1/rooms/${client.room}/invites/${g.id}`,
                                      "DELETE",
                                      client.token,
                                    );
                                    await refresh();
                                  })
                                }
                              >
                                Отозвать
                              </Button>
                            </div>
                          ))}
                      </details>
                      <details>
                        <summary>Доступ аккаунтов</summary>
                        <label className="field-label">
                          Логин участника
                          <input
                            value={member}
                            onChange={(e) => setMember(e.target.value)}
                          />
                        </label>
                        <Button
                          disabled={busy || !member}
                          onClick={() =>
                            void run(async () => {
                              await api(
                                client.server,
                                `/v1/rooms/${client.room}/members`,
                                "POST",
                                client.token,
                                { login: member, role },
                              );
                              setMember("");
                              await refresh();
                            })
                          }
                        >
                          Добавить с выбранной ролью
                        </Button>
                        {members.map((m) => (
                          <div className="shared-access-row" key={m.login}>
                            <span>
                              {m.name} · {m.role}
                            </span>
                            <Button
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  await api(
                                    client.server,
                                    `/v1/rooms/${client.room}/members/${encodeURIComponent(m.login)}`,
                                    "DELETE",
                                    client.token,
                                  );
                                  await refresh();
                                })
                              }
                            >
                              Убрать доступ
                            </Button>
                          </div>
                        ))}
                      </details>
                      {account && (
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await api(
                                client.server,
                                `/v1/rooms/${client.room}/claim`,
                                "POST",
                                client.token,
                                { accountToken: account.token },
                              );
                              await connect(
                                client.server,
                                client.room,
                                account.token,
                              );
                            })
                          }
                        >
                          Закрепить за моим аккаунтом
                        </Button>
                      )}
                      {client.accessKind === "invitation" && (
                        <details open={!!error}>
                          <summary>Сохранить доступ владельца</summary>
                          <p>
                            Сохраните это приглашение отдельно. Оно даёт полный
                            контроль над доской. Для постоянного доступа можно
                            создать аккаунт.
                          </p>
                          <textarea
                            readOnly
                            rows={4}
                            value={invitation(
                              client.server,
                              client.room,
                              client.token,
                            )}
                          />
                        </details>
                      )}
                    </>
                  )}
                  <Button disabled={busy} onClick={() => void run(disconnect)}>
                    Отключиться и оставить локальную копию
                  </Button>
                </>
              ) : (
                <>
                  <p>
                    Создайте общую копию текущей доски или подключитесь по
                    приглашению. Исходный файл останется на устройстве.
                  </p>
                  <label className="field-label">
                    Адрес сервиса
                    <input
                      aria-label="Адрес сервиса"
                      value={server}
                      onChange={(e) => setServer(e.target.value)}
                      placeholder="https://boards.example.org"
                    />
                  </label>
                  <Button
                    appearance="primary"
                    disabled={busy || !server}
                    onClick={() =>
                      void run(async () => {
                        await flush();
                        const url = serviceUrl(server);
                        const r = await createRoom(
                          url,
                          editor.document,
                          account?.server === url ? account.token : "",
                        );
                        localStorage.setItem("lightpen.service", url);
                        await remember(() =>
                          credentialStore.rememberRoom({
                            server: url,
                            room: r.id,
                            token: r.token,
                            title: editor.document.title,
                            role: r.role,
                            accessedAt: Date.now(),
                          }),
                        );
                        await connect(url, r.id, r.token);
                      })
                    }
                  >
                    {account
                      ? "Создать общую доску в аккаунте"
                      : "Создать общую доску без аккаунта"}
                  </Button>
                  <details open>
                    <summary>У меня есть приглашение</summary>
                    <textarea
                      aria-label="Приглашение Light Pen"
                      rows={4}
                      value={invite}
                      onChange={(e) => setInvite(e.target.value)}
                      placeholder="Вставьте приглашение целиком"
                    />
                    <Button
                      disabled={busy || !invite}
                      onClick={() =>
                        void run(async () => {
                          const p = parseInvitation(invite);
                          await connect(p.service, p.room, p.token);
                          setInvite("");
                        })
                      }
                    >
                      Подключиться
                    </Button>
                  </details>
                  {!!savedRooms.length && (
                    <details className="saved-shared-rooms" open>
                      <summary>Сохранённый доступ</summary>
                      <div className="shared-room-list">
                        {[...savedRooms]
                          .sort((a, b) => b.accessedAt - a.accessedAt)
                          .map((r) => (
                            <div
                              key={r.server + "/" + r.room}
                              className="saved-access-row"
                            >
                              <Button
                                disabled={busy}
                                onClick={() =>
                                  void run(() =>
                                    connect(r.server, r.room, r.token),
                                  )
                                }
                              >
                                {r.title || "Доска"} ·{" "}
                                {r.role === "owner"
                                  ? "Владелец"
                                  : r.role === "editor"
                                    ? "Редактор"
                                    : "Просмотр"}
                              </Button>
                              <Button
                                size="small"
                                appearance="subtle"
                                disabled={busy}
                                aria-label={`Забыть сохранённый доступ ${r.room}`}
                                onClick={() => {
                                  setError("");
                                  setForget(r);
                                }}
                              >
                                Забыть
                              </Button>
                            </div>
                          ))}
                      </div>
                    </details>
                  )}
                </>
              )}
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setOpen(false)}>
                Закрыть
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <Dialog
        open={!!forget}
        onOpenChange={(_, data) => {
          if (!data.open && !busy) setForget(null);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Забыть сохранённый доступ?</DialogTitle>
            <DialogContent>
              <p>
                Будет удалён сохранённый доступ к доске «{forget?.title}» с
                этого компьютера. Чтобы вернуться к гостевой доске, потребуется
                приглашение.
              </p>
              {!!error && (
                <p className="inline-error" role="alert">
                  {error}
                </p>
              )}
            </DialogContent>
            <DialogActions>
              <Button disabled={busy} onClick={() => setForget(null)}>
                Оставить
              </Button>
              <Button
                disabled={busy}
                appearance="primary"
                onClick={() =>
                  void run(async () => {
                    if (!forget) return;
                    await credentialStore.forgetRoom(
                      forget.server,
                      forget.room,
                    );
                    await refreshSaved();
                    setForget(null);
                  })
                }
              >
                Забыть на этом ПК
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </>
  );
}
