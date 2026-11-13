/** Minimal terminal styling: colour only on an interactive terminal, and never when NO_COLOR is set. */
const useColor =
  Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env) && process.env.TERM !== "dumb";

function wrap(open: number, close: number): (text: string) => string {
  return (text) => (useColor ? `\u001b[${open}m${text}\u001b[${close}m` : text);
}

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);

export function rule(width = 72): string {
  return dim("─".repeat(width));
}
