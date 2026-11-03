import { useEffect, useState } from "react";
import { Button, Slider } from "@fluentui/react-components";
import type { Editor } from "../editor/editor";

export function TextControls({ editor }: { editor: Editor }) {
  const texts = editor.selection.filter((e) =>
    ["text", "sticky", "math", "frame", "table", "task", "link"].includes(
      e.kind,
    ),
  );
  const current = texts[0] ?? editor.style,
    size = current.fontSize ?? 24;
  const [input, setInput] = useState(String(size));
  useEffect(() => setInput(String(size)), [size]);
  const update = (n: number) => {
    editor.beginStyle();
    editor.setStyle({ fontSize: Math.max(8, Math.min(256, Math.round(n))) });
  };
  const finish = () => {
    const n = Number(input);
    update(Number.isFinite(n) && input !== "" ? n : size);
    editor.endStyle();
  };
  const sizes = [12, 16, 20, 24, 32, 48, 64, 96];
  return (
    <section className="text-controls" aria-label="Оформление текста">
      <div className="property-label">
        Размер текста{texts.some((e) => e.fontSize !== size) ? " · разный" : ""}
      </div>
      <div className="text-size-row">
        <Slider
          min={8}
          max={256}
          value={size}
          aria-label="Размер текста"
          onPointerDown={() => editor.beginStyle()}
          onKeyDown={() => editor.beginStyle()}
          onChange={(_, data) => update(data.value)}
          onPointerUp={() => editor.endStyle()}
          onLostPointerCapture={() => editor.endStyle()}
          onKeyUp={() => editor.endStyle()}
          onBlur={() => editor.endStyle()}
        />
        <input
          className="number-field"
          type="number"
          min={8}
          max={256}
          step={1}
          aria-label="Размер текста, число"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value !== "" && n >= 8 && n <= 256) update(n);
          }}
          onBlur={finish}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      </div>
      <select
        className="property-select"
        aria-label="Стандартный размер текста"
        value={sizes.includes(size) ? size : ""}
        onChange={(e) => {
          editor.setStyle({ fontSize: Number(e.target.value) });
        }}
      >
        <option value="" disabled>
          Свой размер
        </option>
        {sizes.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      {texts[0]?.kind !== "math" && editor.tool !== "math" && (
        <>
          <div className="format-row">
            <Button
              size="small"
              appearance={current.bold ? "primary" : "subtle"}
              aria-label="Жирный"
              aria-pressed={!!current.bold}
              onClick={() => editor.setStyle({ bold: !current.bold })}
            >
              <b>Ж</b>
            </Button>
            <Button
              size="small"
              appearance={current.italic ? "primary" : "subtle"}
              aria-label="Курсив"
              aria-pressed={!!current.italic}
              onClick={() => editor.setStyle({ italic: !current.italic })}
            >
              <i>К</i>
            </Button>
            {(["left", "center", "right"] as const).map((align, i) => (
              <Button
                key={align}
                size="small"
                appearance={
                  (current.textAlign ?? "left") === align ? "primary" : "subtle"
                }
                aria-label={
                  ["Текст слева", "Текст по центру", "Текст справа"][i]
                }
                aria-pressed={(current.textAlign ?? "left") === align}
                onClick={() => editor.setStyle({ textAlign: align })}
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  stroke="currentColor"
                >
                  <path
                    d={
                      align === "left"
                        ? "M1 3h14M1 6h9M1 9h14M1 12h9"
                        : align === "right"
                          ? "M1 3h14M6 6h9M1 9h14M6 12h9"
                          : "M1 3h14M4 6h8M1 9h14M4 12h8"
                    }
                  />
                </svg>
              </Button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

export { ColorPalette as CustomColor } from "./ColorPalette";
