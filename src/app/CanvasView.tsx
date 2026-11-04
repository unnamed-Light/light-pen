import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Editor } from "../editor/editor";
import { clamp, screenToWorld, rotationCenter } from "../editor/model/geometry";
import { BoardRenderer } from "../editor/render/renderer";
import { keyboardCode } from "../platform/keyboard";
import type { LocalLink } from "../editor/model/types";

function usableLink(link: LocalLink | null | undefined): link is LocalLink {
  return !!(link && (link.path || link.pageId || link.elementId));
}

export function CanvasView({
  editor,
  dark,
  onRenderer,
}: {
  editor: Editor;
  dark: boolean;
  onRenderer: (renderer: BoardRenderer | null) => void;
}) {
  const main = useRef<HTMLCanvasElement>(null),
    overlay = useRef<HTMLCanvasElement>(null),
    host = useRef<HTMLDivElement>(null),
    text = useRef<HTMLTextAreaElement>(null);
  const renderer = useRef<BoardRenderer | null>(null);
  const [linkHover, setLinkHover] = useState(false);
  useSyncExternalStore(editor.subscribeUi, editor.getSnapshot);
  useSyncExternalStore(editor.subscribeCamera, editor.getCameraSnapshot);
  useEffect(() => {
    const canvas = overlay.current!,
      container = host.current!;
    const painter = new BoardRenderer(editor, main.current!, canvas);
    renderer.current = painter;
    onRenderer(painter);
    const observer = new ResizeObserver(() =>
      painter.resize(container.clientWidth, container.clientHeight),
    );
    observer.observe(container);
    painter.resize(container.clientWidth, container.clientHeight);
    const touch = new Map<number, { x: number; y: number }>();
    const linkPointers = new Set<number>();
    let lastPointer: { x: number; y: number } | null = null;
    let hoveringLink = false;
    const hoverLink = (value: boolean) => {
      if (hoveringLink === value) return;
      hoveringLink = value;
      setLinkHover(value);
    };
    let penActive = false;
    let pinch: {
      distance: number;
      center: { x: number; y: number };
      camera: typeof editor.camera;
    } | null = null;
    const position = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const sample = (e: PointerEvent) => ({
      ...position(e),
      pressure: e.pressure,
      pointerType: e.pointerType,
      time: e.timeStamp,
    });
    const linkAt = (point: { x: number; y: number }) => {
      const link = editor.pick(screenToWorld(point, editor.camera), true)?.link;
      return usableLink(link) ? link : null;
    };
    const openLink = (link: NonNullable<typeof editor.linkRequest>) => {
      editor.cancelGesture();
      editor.linkRequest = structuredClone(link);
      editor.emit("ui");
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType === "touch" && penActive) return;
      e.preventDefault();
      canvas.focus({ preventScroll: true });
      linkPointers.delete(e.pointerId);
      if (
        e.button === 0 &&
        (e.ctrlKey || e.metaKey) &&
        editor.enabled &&
        !editor.isInteracting &&
        !editor.replay &&
        !editor.presenting
      ) {
        const link = linkAt(position(e));
        if (link) {
          linkPointers.add(e.pointerId);
          openLink(link);
          return;
        }
      }
      if (e.pointerType === "pen") {
        penActive = true;
        if (touch.size) {
          editor.cancelGesture();
          touch.clear();
          pinch = null;
        }
      }
      if (e.pointerType === "touch") {
        touch.set(e.pointerId, position(e));
        if (touch.size === 2) {
          editor.cancelGesture();
          const [a, b] = [...touch.values()];
          pinch = {
            distance: Math.hypot(a.x - b.x, a.y - b.y),
            center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
            camera: { ...editor.camera },
          };
          canvas.setPointerCapture(e.pointerId);
          return;
        }
        if (pinch) return;
      }
      if (
        editor.pointerDown(
          position(e),
          e.pointerId,
          sample(e),
          e.button,
          e.shiftKey,
        )
      )
        canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      lastPointer = position(e);
      hoverLink(
        !!((e.ctrlKey || e.metaKey) && !editor.gesture && linkAt(lastPointer)),
      );
      if (linkPointers.has(e.pointerId)) return;
      if (e.pointerType === "touch" && penActive) return;
      if (touch.has(e.pointerId)) touch.set(e.pointerId, position(e));
      if (pinch) {
        if (touch.size === 2) {
          const [a, b] = [...touch.values()],
            zoom = clamp(
              (pinch.camera.zoom * Math.hypot(a.x - b.x, a.y - b.y)) /
                Math.max(1, pinch.distance),
              0.05,
              8,
            ),
            anchor = screenToWorld(pinch.center, pinch.camera);
          editor.setCamera({
            zoom,
            x: (a.x + b.x) / 2 - anchor.x * zoom,
            y: (a.y + b.y) / 2 - anchor.y * zoom,
          });
        }
        return;
      }
      const samples =
        editor.gesture?.type === "ink" ? (e.getCoalescedEvents?.() ?? []) : [];
      for (const point of samples.length ? samples : [e])
        editor.pointerMove(
          position(point),
          e.pointerId,
          sample(point),
          e.shiftKey,
        );
    };
    const up = (e: PointerEvent) => {
      if (linkPointers.delete(e.pointerId)) return;
      if (e.pointerType === "pen") penActive = false;
      touch.delete(e.pointerId);
      if (pinch) {
        if (touch.size === 0) pinch = null;
        if (canvas.hasPointerCapture(e.pointerId))
          canvas.releasePointerCapture(e.pointerId);
        return;
      }
      const g = editor.gesture;
      if (g && g.type !== "ink")
        editor.pointerMove(position(e), e.pointerId, sample(e), e.shiftKey);
      editor.pointerUp(e.pointerId);
      if (canvas.hasPointerCapture(e.pointerId))
        canvas.releasePointerCapture(e.pointerId);
    };
    const cancel = (e: PointerEvent) => {
      linkPointers.delete(e.pointerId);
      touch.delete(e.pointerId);
      if (e.pointerType === "pen") penActive = false;
      pinch = null;
      editor.cancelGesture();
    };
    const lost = (e: PointerEvent) => {
      if (editor.gesture?.pointer === e.pointerId) editor.cancelGesture();
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (editor.replay) return;
      const r = canvas.getBoundingClientRect();
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY))
        editor.setCamera({
          ...editor.camera,
          x: editor.camera.x - e.deltaX - (e.shiftKey ? e.deltaY : 0),
          y: editor.camera.y - (e.shiftKey ? 0 : e.deltaY),
        });
      else
        editor.zoom(Math.exp(-e.deltaY * 0.0015), {
          x: e.clientX - r.left,
          y: e.clientY - r.top,
        });
    };
    const dbl = (e: MouseEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      const r = canvas.getBoundingClientRect();
      editor.doubleClick({ x: e.clientX - r.left, y: e.clientY - r.top });
    };
    const context = (e: MouseEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      editor.showContextMenu({ x: e.clientX - r.left, y: e.clientY - r.top });
    };
    const blur = () => {
      linkPointers.clear();
      lastPointer = null;
      hoverLink(false);
      editor.spaceHeld = false;
      editor.cancelGesture();
      touch.clear();
      pinch = null;
      penActive = false;
    };
    const leave = () => {
      lastPointer = null;
      hoverLink(false);
    };
    const key = (e: KeyboardEvent) => {
      if (
        e.target !== canvas ||
        !editor.enabled ||
        editor.isInteracting ||
        editor.presenting ||
        editor.replay
      )
        return;
      if (
        (e.ctrlKey || e.metaKey) &&
        e.type === "keydown" &&
        keyboardCode(e) === "Enter" &&
        editor.selection.length === 1 &&
        usableLink(editor.selection[0].link)
      ) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) openLink(editor.selection[0].link);
      } else
        hoverLink(
          !!((e.ctrlKey || e.metaKey) && lastPointer && linkAt(lastPointer)),
        );
    };
    const resize = () =>
      painter.resize(container.clientWidth, container.clientHeight);
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", cancel);
    canvas.addEventListener("lostpointercapture", lost);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("dblclick", dbl);
    canvas.addEventListener("contextmenu", context);
    canvas.addEventListener("pointerleave", leave);
    canvas.addEventListener("keydown", key);
    canvas.addEventListener("keyup", key);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      painter.dispose();
      renderer.current = null;
      onRenderer(null);
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointercancel", cancel);
      canvas.removeEventListener("lostpointercapture", lost);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("dblclick", dbl);
      canvas.removeEventListener("contextmenu", context);
      canvas.removeEventListener("pointerleave", leave);
      canvas.removeEventListener("keydown", key);
      canvas.removeEventListener("keyup", key);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", resize);
    };
  }, [editor, onRenderer]);
  useEffect(() => renderer.current?.setDark(dark), [dark]);
  const editing = editor.editing;
  useLayoutEffect(() => {
    if (editing && text.current) {
      text.current.focus({ preventScroll: true });
      if (!editing.isNew) text.current.select();
    }
  }, [editing?.element.id]);
  const c = editor.camera,
    el = editing?.element;
  const cursor = linkHover
    ? "pointer"
    : editor.replay
      ? "default"
      : editor.spaceHeld || editor.tool === "hand"
        ? "grab"
        : editor.tool === "select"
          ? "default"
          : editor.tool === "text"
            ? "text"
            : editor.tool === "eraser"
              ? "none"
              : "crosshair";
  return (
    <div className="canvas-host" ref={host} data-testid="canvas-host">
      <canvas className="board-canvas" ref={main} aria-hidden="true" />
      <canvas
        className="board-overlay"
        ref={overlay}
        tabIndex={0}
        role="application"
        aria-label="Интерактивная доска"
        title={
          linkHover
            ? "Открыть ссылку · Ctrl+щелчок"
            : editor.selection.length === 1 &&
                usableLink(editor.selection[0].link)
              ? "Открыть ссылку выделенного объекта · Ctrl+Enter"
              : undefined
        }
        style={{ cursor }}
        data-testid="board"
      />
      {el && editing && (
        <textarea
          ref={text}
          className={`text-editor ${el.kind === "sticky" ? "sticky-editor" : ""}`}
          aria-label="Текст объекта"
          spellCheck={false}
          value={editing.value}
          placeholder={el.kind === "sticky" ? "Ваша мысль…" : "Введите текст…"}
          style={{
            left: el.x * c.zoom + c.x,
            top: el.y * c.zoom + c.y,
            width: el.width,
            height:
              el.kind === "frame"
                ? (el.fontSize ?? 20) * 1.35 + 8
                : el.kind === "sticky"
                  ? el.height
                  : Math.max(el.height, 120),
            fontSize: el.fontSize,
            fontWeight: el.bold ? 700 : 400,
            fontStyle: el.italic ? "italic" : "normal",
            textAlign: el.textAlign ?? "left",
            color:
              el.kind === "sticky"
                ? "#242424"
                : dark && el.color === "#242424"
                  ? "#f0f0f0"
                  : el.color,
            background: el.kind === "sticky" ? el.fill : "transparent",
            transform: `scale(${c.zoom}) translate(${rotationCenter(el).x - el.x}px,${rotationCenter(el).y - el.y}px) rotate(${el.rotation ?? 0}deg) translate(${el.x - rotationCenter(el).x}px,${el.y - rotationCenter(el).y}px)`,
          }}
          onChange={(e) => editor.updateText(e.target.value)}
          onBlur={() => editor.commitText()}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              editor.cancelText();
              overlay.current?.focus();
            } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              editor.commitText();
              overlay.current?.focus();
            }
          }}
        />
      )}
      {!editor.elements.length && !editor.gesture && !editing && (
        <div className="empty-state">
          <div className="empty-ink">
            <svg width="56" height="56" viewBox="0 0 56 56">
              <path
                d="M8 41c8-15 10-19 17-13s9 8 22-1"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
              <path
                d="m27 20 9-9 7 7-9 9-10 3z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
            </svg>
          </div>
          <h1>Место для вашей идеи</h1>
          <p>Начните рисовать или выберите инструмент слева.</p>
          <span>Колесо — масштаб · Space + перетаскивание — перемещение</span>
        </div>
      )}
    </div>
  );
}
