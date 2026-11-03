import { useEffect, useRef, useState } from "react";
import { Button, Tooltip } from "@fluentui/react-components";
import {
  Map20Regular,
  Dismiss20Regular,
  Previous20Regular,
  Next20Regular,
} from "@fluentui/react-icons";
import type { Editor } from "../editor/editor";
import type { Camera, Vec } from "../editor/model/types";
import {
  bounds,
  expand,
  screenToWorld,
  unionBounds,
} from "../editor/model/geometry";
import { connectorPoints } from "../editor/model/connectors";

export function Minimap({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(
      () => localStorage.getItem("lightpen.minimap") === "true",
    ),
    canvas = useRef<HTMLCanvasElement>(null);
  const mapping = useRef({ minX: 0, minY: 0, scale: 1 }),
    drag = useRef<Vec | null>(null);
  useEffect(() => {
    if (!open || !canvas.current) return;
    const target = canvas.current,
      ctx = target.getContext("2d")!,
      base = document.createElement("canvas");
    base.width = 400;
    base.height = 240;
    const cached = base.getContext("2d")!;
    let lastElements = editor.elements;
    const rebuild = () => {
      const elements = editor.elements.filter((e) => !e.hidden),
        b = expand(unionBounds(elements) ?? editor.visibleBounds(), 40),
        w = Math.max(80, b.maxX - b.minX),
        h = Math.max(80, b.maxY - b.minY),
        scale = Math.min(184 / w, 104 / h);
      mapping.current = {
        minX: (b.minX + b.maxX) / 2 - 100 / scale,
        minY: (b.minY + b.maxY) / 2 - 60 / scale,
        scale,
      };
      const map = mapping.current;
      cached.setTransform(1, 0, 0, 1, 0, 0);
      cached.clearRect(0, 0, 400, 240);
      cached.setTransform(
        scale * 2,
        0,
        0,
        scale * 2,
        -map.minX * scale * 2,
        -map.minY * scale * 2,
      );
      for (const el of elements) {
        const r = bounds(el);
        cached.globalAlpha = Math.max(0.25, el.opacity);
        cached.strokeStyle = el.color;
        cached.fillStyle = el.fill === "transparent" ? "#c7c7c7" : el.fill;
        cached.lineWidth = Math.max(el.strokeWidth, 1 / scale);
        if (el.kind === "stroke") {
          const p = el.points!;
          cached.beginPath();
          cached.moveTo(el.x + p[0][0], el.y + p[0][1]);
          const step = Math.max(1, Math.floor(p.length / 150));
          for (let i = 1; i < p.length; i += step)
            cached.lineTo(el.x + p[i][0], el.y + p[i][1]);
          cached.stroke();
        } else if (el.kind === "arrow" || el.kind === "line") {
          cached.beginPath();
          connectorPoints(el).forEach((p, i) =>
            i
              ? cached.lineTo(el.x + p.x, el.y + p.y)
              : cached.moveTo(el.x + p.x, el.y + p.y),
          );
          cached.stroke();
        } else {
          if (el.kind !== "frame")
            cached.fillRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
          cached.strokeRect(r.minX, r.minY, r.maxX - r.minX, r.maxY - r.minY);
        }
      }
      cached.globalAlpha = 1;
    };
    const paint = () => {
      if (editor.elements !== lastElements) {
        lastElements = editor.elements;
        rebuild();
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, 400, 240);
      ctx.drawImage(base, 0, 0);
      const b = editor.visibleBounds(),
        m = mapping.current;
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      ctx.fillStyle = "#0f6cbd22";
      ctx.strokeStyle = "#0f6cbd";
      ctx.lineWidth = 1.5;
      ctx.fillRect(
        (b.minX - m.minX) * m.scale,
        (b.minY - m.minY) * m.scale,
        (b.maxX - b.minX) * m.scale,
        (b.maxY - b.minY) * m.scale,
      );
      ctx.strokeRect(
        (b.minX - m.minX) * m.scale,
        (b.minY - m.minY) * m.scale,
        (b.maxX - b.minX) * m.scale,
        (b.maxY - b.minY) * m.scale,
      );
    };
    rebuild();
    paint();
    let raf = 0;
    const off = editor.subscribe((s) => {
      if (["camera", "scene", "document"].includes(s) && !raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          paint();
        });
    });
    return () => {
      off();
      cancelAnimationFrame(raf);
    };
  }, [open, editor]);
  const world = (e: React.PointerEvent) => {
    const r = e.currentTarget.getBoundingClientRect(),
      m = mapping.current;
    return {
      x: m.minX + ((e.clientX - r.left) * 200) / r.width / m.scale,
      y: m.minY + ((e.clientY - r.top) * 120) / r.height / m.scale,
    };
  };
  const move = (p: Vec) =>
    editor.setCamera({
      ...editor.camera,
      x:
        editor.viewport.width / 2 -
        (p.x + (drag.current?.x ?? 0)) * editor.camera.zoom,
      y:
        editor.viewport.height / 2 -
        (p.y + (drag.current?.y ?? 0)) * editor.camera.zoom,
    });
  return (
    <div className={`minimap floating ${open ? "expanded" : ""}`}>
      <div className="minimap-title">
        <Tooltip content="Миникарта" relationship="label">
          <Button
            size="small"
            appearance="subtle"
            aria-label={open ? "Свернуть миникарту" : "Миникарта"}
            icon={open ? <Dismiss20Regular /> : <Map20Regular />}
            onClick={() => {
              localStorage.setItem("lightpen.minimap", String(!open));
              setOpen(!open);
            }}
          >
            {open ? "Миникарта" : undefined}
          </Button>
        </Tooltip>
      </div>
      {open && (
        <canvas
          width={400}
          height={240}
          ref={canvas}
          aria-label="Навигация по миникарте"
          role="application"
          tabIndex={0}
          onPointerDown={(e) => {
            const p = world(e),
              b = editor.visibleBounds();
            drag.current =
              p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY
                ? {
                    x: (b.minX + b.maxX) / 2 - p.x,
                    y: (b.minY + b.maxY) / 2 - p.y,
                  }
                : { x: 0, y: 0 };
            e.currentTarget.setPointerCapture(e.pointerId);
            move(p);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) move(world(e));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(e) => {
            const delta = 80 / editor.camera.zoom;
            if (
              ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                e.key,
              )
            ) {
              e.preventDefault();
              editor.setCamera({
                ...editor.camera,
                x:
                  editor.camera.x +
                  (e.key === "ArrowLeft"
                    ? delta
                    : e.key === "ArrowRight"
                      ? -delta
                      : 0) *
                    editor.camera.zoom,
                y:
                  editor.camera.y +
                  (e.key === "ArrowUp"
                    ? delta
                    : e.key === "ArrowDown"
                      ? -delta
                      : 0) *
                    editor.camera.zoom,
              });
            }
          }}
        />
      )}
    </div>
  );
}
export function Presentation({
  editor,
  onClose,
}: {
  editor: Editor;
  onClose: () => void;
}) {
  const slides = editor.slides,
    [index, setIndex] = useState(0),
    [mode, setMode] = useState<"laser" | "ink">("laser"),
    [laser, setLaser] = useState<Vec | null>(null),
    [strokes, setStrokes] = useState<Vec[][]>([]),
    [active, setActive] = useState<Vec[]>([]),
    previous = useRef<Camera>({ ...editor.camera });
  const change = (i: number) => {
    const next = Math.max(0, Math.min(slides.length - 1, i));
    setIndex(next);
    setStrokes([]);
    setActive([]);
    setLaser(null);
    editor.showSlide(slides[next].id);
  };
  useEffect(() => {
    editor.commitText();
    editor.endStyle();
    editor.cancelGesture();
    editor.stopReplay();
    editor.selected.clear();
    editor.presenting = true;
    editor.showSlide(slides[0].id);
    editor.emit("scene");
    return () => {
      editor.presenting = false;
      editor.presentationFrame = null;
      editor.setCamera(previous.current);
    };
  }, [editor]);
  useEffect(() => {
    editor.showSlide(slides[index].id);
  }, [editor, index, editor.viewport.width, editor.viewport.height]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        [
          "Escape",
          "ArrowRight",
          "ArrowLeft",
          "PageDown",
          "PageUp",
          "Home",
          "End",
        ].includes(e.key)
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.key === "Escape") onClose();
        else
          change(
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? slides.length - 1
                : index + (["ArrowRight", "PageDown"].includes(e.key) ? 1 : -1),
          );
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  const point = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return screenToWorld(
      { x: e.clientX - r.left, y: e.clientY - r.top },
      editor.camera,
    );
  };
  const c = editor.camera;
  return (
    <div
      className="presentation"
      aria-label="Презентация"
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg
        className="presentation-input"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = point(e);
          setLaser(p);
          if (mode === "ink") setActive([p]);
        }}
        onPointerMove={(e) => {
          const p = point(e);
          if (mode === "laser") setLaser(p);
          else if (e.currentTarget.hasPointerCapture(e.pointerId))
            setActive((a) => [...a, p]);
        }}
        onPointerUp={() => {
          if (active.length) setStrokes((s) => [...s, active]);
          setActive([]);
        }}
        onPointerCancel={() => setActive([])}
        onPointerLeave={() => setLaser(null)}
      >
        <g transform={`translate(${c.x} ${c.y}) scale(${c.zoom})`}>
          {[...strokes, ...(active.length ? [active] : [])].map((line, i) => (
            <polyline
              key={i}
              points={line.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none"
              stroke="#d13438"
              strokeWidth={3 / c.zoom}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ))}
          {mode === "laser" && laser && (
            <>
              <circle
                cx={laser.x}
                cy={laser.y}
                r={12 / c.zoom}
                fill="#d1343833"
              />
              <circle cx={laser.x} cy={laser.y} r={4 / c.zoom} fill="#d13438" />
            </>
          )}
        </g>
      </svg>
      <div className="presentation-controls floating">
        <Button
          appearance="subtle"
          icon={<Previous20Regular />}
          aria-label="Предыдущий слайд"
          disabled={index === 0}
          onClick={() => change(index - 1)}
        />
        <span className="slide-title">
          {index + 1} / {slides.length} · {slides[index].text || "Фрейм"}
        </span>
        <Button
          appearance="subtle"
          icon={<Next20Regular />}
          aria-label="Следующий слайд"
          disabled={index === slides.length - 1}
          onClick={() => change(index + 1)}
        />
        <select
          aria-label="Указатель презентации"
          value={mode}
          onChange={(e) => {
            setMode(e.target.value as typeof mode);
            setLaser(null);
          }}
        >
          <option value="laser">Лазер</option>
          <option value="ink">Пометки</option>
        </select>
        <Button
          appearance="subtle"
          onClick={() => {
            setStrokes([]);
            setActive([]);
          }}
        >
          Очистить
        </Button>
        <Button
          appearance="subtle"
          icon={<Dismiss20Regular />}
          aria-label="Завершить презентацию"
          onClick={onClose}
        />
      </div>
      <p className="presentation-hint">
        ← → — слайды · Esc — выход · пометки не меняют доску
      </p>
    </div>
  );
}
