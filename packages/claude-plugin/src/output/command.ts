import { detectFamily, isSimpleCommand } from "./families";

/** POSIX shell word quoting. Every value is data, even values containing shell syntax. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface WrapperCommandInput {
  command: string;
  executable: string;
  entry: string;
  socket: string;
  toolUseId: string;
}

export function buildWrapperCommand(input: WrapperCommandInput): string | undefined {
  if (!detectFamily(input.command) || !isSimpleCommand(input.command)) return undefined;
  return [input.executable, input.entry, "--socket", input.socket, "--tool-use-id", input.toolUseId, "--command", input.command]
    .map(shellQuote)
    .join(" ");
}
