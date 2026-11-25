import { styleText } from "node:util";

export const interactiveTerminal = () =>
  process.stdin.isTTY && process.stderr.isTTY && process.env.TERM !== "dumb";

export const style = (
  format: Parameters<typeof styleText>[0],
  text: string,
  stream: NodeJS.WriteStream = process.stderr,
) =>
  stream.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb"
    ? styleText(format, text, { stream })
    : text;
