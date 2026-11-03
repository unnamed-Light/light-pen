import type { SceneElement } from "../model/types";

export const STATUS_TEXT = {
  todo: "К выполнению",
  doing: "В работе",
  done: "Готово",
};
export function drawStructured(
  ctx: CanvasRenderingContext2D,
  el: SceneElement,
  dark: boolean,
) {
  const size = el.fontSize ?? 18,
    surface =
      el.fill === "transparent" ? (dark ? "#292929" : "#ffffff") : el.fill;
  ctx.fillStyle = surface;
  ctx.strokeStyle = el.color;
  ctx.lineWidth = el.strokeWidth;
  ctx.beginPath();
  ctx.roundRect(0, 0, el.width, el.height, 6);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.rect(1, 1, Math.max(0, el.width - 2), Math.max(0, el.height - 2));
  ctx.clip();
  ctx.font = `${el.italic ? "italic " : ""}${el.bold ? "700 " : ""}${size}px "Segoe UI",sans-serif`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const ink = dark && surface === "#292929" ? "#f0f0f0" : "#242424";
  if (el.kind === "table" && el.cells?.length) {
    const rh = el.height / el.cells.length,
      cw = el.width / el.cells[0].length;
    ctx.fillStyle = dark && surface === "#292929" ? "#173c5e" : "#e5f0fa";
    ctx.fillRect(0, 0, el.width, rh);
    ctx.strokeStyle = dark ? "#666666" : "#c7c7c7";
    ctx.lineWidth = 1;
    for (let i = 1; i < el.cells.length; i++) {
      ctx.beginPath();
      ctx.moveTo(0, rh * i);
      ctx.lineTo(el.width, rh * i);
      ctx.stroke();
    }
    for (let i = 1; i < el.cells[0].length; i++) {
      ctx.beginPath();
      ctx.moveTo(cw * i, 0);
      ctx.lineTo(cw * i, el.height);
      ctx.stroke();
    }
    el.cells.forEach((row, r) =>
      row.forEach((cell, c) => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(
          c * cw + 6,
          r * rh + 2,
          Math.max(1, cw - 12),
          Math.max(1, rh - 4),
        );
        ctx.clip();
        ctx.fillStyle = ink;
        ctx.font = `${r === 0 || el.bold ? "700 " : ""}${el.italic ? "italic " : ""}${size}px "Segoe UI",sans-serif`;
        ctx.textAlign = el.textAlign ?? "left";
        const x =
          c * cw +
          (el.textAlign === "center"
            ? cw / 2
            : el.textAlign === "right"
              ? cw - 10
              : 10);
        const lines = cell.split("\n");
        lines.forEach((line, i) =>
          ctx.fillText(
            line,
            x,
            r * rh + rh / 2 + (i - (lines.length - 1) / 2) * size * 1.2,
          ),
        );
        ctx.restore();
      }),
    );
  } else if (el.kind === "task" && el.task) {
    ctx.fillStyle = ink;
    ctx.font = `600 ${size}px "Segoe UI",sans-serif`;
    ctx.fillText(el.text ?? "Задача", 16, 26, Math.max(1, el.width - 32));
    ctx.font = '12px "Segoe UI",sans-serif';
    ctx.fillStyle = el.task.status === "done" ? "#107c50" : "#0f6cbd";
    ctx.fillText(
      STATUS_TEXT[el.task.status] + (el.task.due ? ` · до ${el.task.due}` : ""),
      16,
      55,
      Math.max(1, el.width - 32),
    );
    el.task.items.forEach((item, i) => {
      const y = 76 + i * 30;
      ctx.strokeStyle = item.done ? "#107c50" : "#8a8a8a";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(18, y + 4, 16, 16);
      if (item.done) {
        ctx.beginPath();
        ctx.moveTo(21, y + 12);
        ctx.lineTo(25, y + 16);
        ctx.lineTo(31, y + 8);
        ctx.stroke();
      }
      ctx.fillStyle = item.done ? "#707070" : ink;
      ctx.font = `${Math.min(size, 20)}px "Segoe UI",sans-serif`;
      ctx.fillText(item.text, 44, y + 13, Math.max(1, el.width - 60));
      if (item.done) {
        ctx.beginPath();
        ctx.moveTo(44, y + 13);
        ctx.lineTo(
          Math.min(el.width - 16, 44 + ctx.measureText(item.text).width),
          y + 13,
        );
        ctx.stroke();
      }
    });
  } else if (el.kind === "link") {
    ctx.fillStyle = el.color;
    ctx.font = `600 ${size}px "Segoe UI",sans-serif`;
    ctx.fillText(
      "↗ " + (el.link?.label || el.text || "Ссылка"),
      16,
      30,
      Math.max(1, el.width - 32),
    );
    ctx.fillStyle = ink;
    ctx.font = '12px "Segoe UI",sans-serif';
    ctx.fillText(
      el.link?.path || "Объект этой доски",
      16,
      58,
      Math.max(1, el.width - 32),
    );
    if (el.link?.elementId)
      ctx.fillText("Переход к объекту", 16, 78, Math.max(1, el.width - 32));
  }
}
