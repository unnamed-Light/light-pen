import { useEffect, useState } from "react";
import {
  Button,
  Popover,
  PopoverTrigger,
  PopoverSurface,
  Slider,
} from "@fluentui/react-components";
import type { Editor } from "../editor/editor";
export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(5)}${f(3)}${f(1)}`;
}
export function hexToHsv(hex: string): [number, number, number] {
  const [r, g, b] = [1, 3, 5].map(
      (i) => parseInt(hex.slice(i, i + 2), 16) / 255,
    ),
    max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    d = max - min;
  let h = 0;
  if (d)
    h =
      max === r
        ? ((g - b) / d) % 6
        : max === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, max ? d / max : 0, max];
}
function stored(key: string) {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "[]") as unknown[])
      .filter(
        (s): s is string => typeof s === "string" && /^#[a-f\d]{6}$/i.test(s),
      )
      .slice(0, 12);
  } catch {
    return [];
  }
}
export function ColorPalette({
  editor,
  fill = false,
}: {
  editor: Editor;
  fill?: boolean;
}) {
  const value =
      editor.selection[0]?.[fill ? "fill" : "color"] ??
      editor.style[fill ? "fill" : "color"],
    color = value === "transparent" ? "#ffffff" : value;
  const [hex, setHex] = useState(color),
    [hsv, setHsv] = useState(() => hexToHsv(color)),
    [open, setOpen] = useState(false),
    [recent, setRecent] = useState(() => stored("lightpen.colors")),
    [favorites, setFavorites] = useState(() =>
      stored("lightpen.favoriteColors"),
    );
  useEffect(() => {
    setHex(color);
    setHsv((previous) => {
      const next = hexToHsv(color);
      return next[1] === 0 ? [previous[0], next[1], next[2]] : next;
    });
  }, [color]);
  useEffect(() => {
    const refresh = () => {
      setRecent(stored("lightpen.colors"));
      setFavorites(stored("lightpen.favoriteColors"));
    };
    window.addEventListener("lightpen-palette", refresh);
    return () => window.removeEventListener("lightpen-palette", refresh);
  }, []);
  const apply = (v: string) => {
    setHex(v);
    editor.setStyle(fill ? { fill: v } : { color: v });
  };
  const remember = (v = color) => {
    editor.endStyle();
    const next = [v, ...recent.filter((c) => c !== v)].slice(0, 12);
    setRecent(next);
    localStorage.setItem("lightpen.colors", JSON.stringify(next));
  };
  const update = (next: [number, number, number]) => {
    editor.beginStyle();
    setHsv(next);
    apply(hsvToHex(...next));
  };
  const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  return (
    <div className="custom-color">
      <div className="custom-color-row">
        <input
          type="color"
          aria-label={fill ? "Свой цвет заливки" : "Свой цвет"}
          value={color}
          onChange={(e) => {
            editor.beginStyle();
            apply(e.target.value);
          }}
          onBlur={() => remember()}
        />
        <input
          className="hex-field"
          aria-label={fill ? "Код цвета заливки" : "Код цвета"}
          maxLength={7}
          value={hex}
          onChange={(e) => setHex(e.target.value)}
          onBlur={() => {
            if (/^#[a-f\d]{6}$/i.test(hex)) {
              apply(hex);
              remember(hex);
            } else setHex(color);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <Popover
          open={open}
          onOpenChange={(_, data) => {
            setOpen(data.open);
            if (!data.open) remember();
          }}
          positioning={{ position: "after", align: "top" }}
        >
          <PopoverTrigger disableButtonEnhancement>
            <Button
              size="small"
              appearance="subtle"
              aria-label={fill ? "Палитра заливки" : "Полная палитра"}
            >
              …
            </Button>
          </PopoverTrigger>
          <PopoverSurface
            className="palette-surface"
            aria-label="Палитра цветов"
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
                remember();
              }
            }}
          >
            <strong>{fill ? "Цвет заливки" : "Цвет объекта"}</strong>
            <div
              className="sv-square"
              role="slider"
              tabIndex={0}
              aria-label="Насыщенность и яркость"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(hsv[1] * 100)}
              aria-valuetext={`Насыщенность ${Math.round(hsv[1] * 100)}, яркость ${Math.round(hsv[2] * 100)}`}
              style={{ backgroundColor: hsvToHex(hsv[0], 1, 1) }}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                const r = e.currentTarget.getBoundingClientRect();
                update([
                  hsv[0],
                  Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
                  1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
                ]);
              }}
              onPointerMove={(e) => {
                if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                const r = e.currentTarget.getBoundingClientRect();
                update([
                  hsv[0],
                  Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
                  1 - Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
                ]);
              }}
              onPointerUp={() => remember()}
              onPointerCancel={() => remember()}
              onKeyDown={(e) => {
                const delta = e.shiftKey ? 0.1 : 0.01;
                if (
                  ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                    e.key,
                  )
                ) {
                  e.preventDefault();
                  update([
                    hsv[0],
                    Math.max(
                      0,
                      Math.min(
                        1,
                        hsv[1] +
                          (e.key === "ArrowLeft"
                            ? -delta
                            : e.key === "ArrowRight"
                              ? delta
                              : 0),
                      ),
                    ),
                    Math.max(
                      0,
                      Math.min(
                        1,
                        hsv[2] +
                          (e.key === "ArrowDown"
                            ? -delta
                            : e.key === "ArrowUp"
                              ? delta
                              : 0),
                      ),
                    ),
                  ]);
                }
              }}
              onKeyUp={() => remember()}
            >
              <i
                style={{
                  left: `${hsv[1] * 100}%`,
                  top: `${(1 - hsv[2]) * 100}%`,
                }}
              />
            </div>
            <label className="property-label">Оттенок</label>
            <Slider
              aria-label="Оттенок"
              min={0}
              max={359}
              value={hsv[0]}
              onChange={(_, d) => update([d.value, hsv[1], hsv[2]])}
              onPointerUp={() => remember()}
              onKeyUp={() => remember()}
              onBlur={() => remember()}
            />
            <div className="rgb-fields">
              {rgb.map((v, i) => (
                <label key={i}>
                  {["R", "G", "B"][i]}
                  <input
                    type="number"
                    aria-label={`Цвет ${["R", "G", "B"][i]}`}
                    min={0}
                    max={255}
                    value={v}
                    onChange={(e) => {
                      const arr = [...rgb];
                      arr[i] = Math.max(
                        0,
                        Math.min(255, Number(e.target.value)),
                      );
                      editor.beginStyle();
                      apply(
                        "#" +
                          arr
                            .map((x) => x.toString(16).padStart(2, "0"))
                            .join(""),
                      );
                    }}
                    onBlur={() => remember()}
                  />
                </label>
              ))}
            </div>
            <Button
              size="small"
              appearance="subtle"
              onClick={() => {
                const next = favorites.includes(color)
                  ? favorites.filter((c) => c !== color)
                  : [color, ...favorites].slice(0, 12);
                setFavorites(next);
                localStorage.setItem(
                  "lightpen.favoriteColors",
                  JSON.stringify(next),
                );
              }}
            >
              {favorites.includes(color)
                ? "Убрать из избранного"
                : "В избранные цвета"}
            </Button>
            {!!favorites.length && (
              <div className="recent-swatches" aria-label="Избранные цвета">
                {favorites.map((v) => (
                  <button
                    key={v}
                    className="swatch"
                    style={{ background: v }}
                    aria-label={`Избранный цвет ${v}`}
                    onClick={() => apply(v)}
                  />
                ))}
              </div>
            )}
          </PopoverSurface>
        </Popover>
      </div>
      {!!recent.length && (
        <div className="recent-swatches" aria-label="Последние цвета">
          {recent.slice(0, 8).map((v) => (
            <button
              key={v}
              className="swatch"
              style={{ background: v }}
              aria-label={`Последний цвет ${v}`}
              onClick={() => apply(v)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
