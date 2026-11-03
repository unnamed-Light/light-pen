/** Keep physical shortcuts across layouts, including software keyboards without code. */
export function keyboardCode(
  event: Pick<KeyboardEvent, "code" | "key" | "keyCode">,
): string {
  if (event.code && event.code !== "Unidentified") return event.code;
  const legacy = event.keyCode;
  if (legacy >= 65 && legacy <= 90) return `Key${String.fromCharCode(legacy)}`;
  if (legacy >= 48 && legacy <= 57) return `Digit${legacy - 48}`;
  if (legacy >= 112 && legacy <= 135) return `F${legacy - 111}`;
  const legacyCodes: Record<number, string> = {
    8: "Backspace",
    9: "Tab",
    13: "Enter",
    27: "Escape",
    32: "Space",
    33: "PageUp",
    34: "PageDown",
    35: "End",
    36: "Home",
    37: "ArrowLeft",
    38: "ArrowUp",
    39: "ArrowRight",
    40: "ArrowDown",
    46: "Delete",
    187: "Equal",
    189: "Minus",
  };
  if (legacyCodes[legacy]) return legacyCodes[legacy];
  if (/^[a-z]$/i.test(event.key)) return `Key${event.key.toUpperCase()}`;
  if (/^[0-9]$/.test(event.key)) return `Digit${event.key}`;
  return (
    (
      {
        " ": "Space",
        Spacebar: "Space",
        Esc: "Escape",
        "=": "Equal",
        "+": "Equal",
        "-": "Minus",
      } as Record<string, string>
    )[event.key] ?? event.key
  );
}
