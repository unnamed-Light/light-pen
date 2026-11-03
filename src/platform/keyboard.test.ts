import { expect, test } from "vitest";
import { keyboardCode } from "./keyboard";
const key = (key: string, keyCode = 0, code = "") => ({ key, keyCode, code });
test("physical shortcut codes retain priority across keyboard layouts", () => {
  expect(keyboardCode(key("з", 80, "KeyP"))).toBe("KeyP");
  expect(keyboardCode(key("End", 35, "Numpad1"))).toBe("Numpad1");
});
test("Windows software input without code supports letters, modifiers and function keys", () => {
  expect(keyboardCode(key("з", 80))).toBe("KeyP");
  expect(keyboardCode(key("F5", 116))).toBe("F5");
  expect(keyboardCode(key(" ", 32))).toBe("Space");
  expect(keyboardCode(key("!", 49))).toBe("Digit1");
  expect(keyboardCode(key("+", 187))).toBe("Equal");
  expect(keyboardCode(key("Escape", 27))).toBe("Escape");
});
test("key names remain usable when software input has neither a code nor legacy number", () => {
  expect(keyboardCode(key("p"))).toBe("KeyP");
  expect(keyboardCode(key("F5", 0, "Unidentified"))).toBe("F5");
  expect(keyboardCode(key("2"))).toBe("Digit2");
  expect(keyboardCode(key("Spacebar"))).toBe("Space");
  expect(keyboardCode(key("ArrowRight"))).toBe("ArrowRight");
});
