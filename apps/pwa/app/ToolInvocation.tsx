import type { ToolPresentationItem } from "./presentation";

export type CommandTokenKind =
  | "plain"
  | "command"
  | "keyword"
  | "option"
  | "string"
  | "variable"
  | "operator"
  | "comment"
  | "assignment"
  | "path";

export type CommandToken = {
  kind: CommandTokenKind;
  text: string;
};

const SHELL_KEYWORDS = new Set([
  "case",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "time",
  "until",
  "while",
]);

const COMMAND_SEPARATORS = new Set(["&&", "||", "|", ";", "&", "("]);
const OPERATORS = [
  "2>>",
  "2>",
  "&>>",
  "&>",
  ">>",
  "<<",
  "&&",
  "||",
  ";;",
  "|&",
  ">",
  "<",
  "|",
  ";",
  "&",
  "(",
  ")",
];

export function ToolInvocation({
  tool,
  className,
}: {
  tool: ToolPresentationItem;
  className: string;
}) {
  const invocation = tool.detail || tool.title || tool.name;
  if (tool.category !== "execute") {
    return <pre className={className}>{invocation}</pre>;
  }

  const bash = isBashLabel(tool.name);
  return (
    <pre
      className={`${className} command-invocation ${bash ? "is-bash" : "is-command"}`}
      data-language={bash ? "bash" : "command"}
    >
      {tokenizeCommandLine(invocation).map((token, index) =>
        token.kind === "plain" ? token.text : (
          <span
            className={`command-token token-${token.kind}`}
            key={`${index}:${token.kind}`}
          >
            {token.text}
          </span>
        ),
      )}
    </pre>
  );
}

export function tokenizeCommandLine(source: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let index = 0;
  let expectsCommand = true;

  const push = (kind: CommandTokenKind, text: string) => {
    if (!text) return;
    const previous = tokens.at(-1);
    if (previous?.kind === kind) {
      previous.text += text;
    } else {
      tokens.push({ kind, text });
    }
  };

  while (index < source.length) {
    const character = source[index] ?? "";

    if (/\s/u.test(character)) {
      const start = index;
      while (index < source.length && /\s/u.test(source[index] ?? "")) index += 1;
      const whitespace = source.slice(start, index);
      push("plain", whitespace);
      if (whitespace.includes("\n")) expectsCommand = true;
      continue;
    }

    if (character === "#" && canStartComment(source, index)) {
      const newline = source.indexOf("\n", index);
      const end = newline === -1 ? source.length : newline;
      push("comment", source.slice(index, end));
      index = end;
      continue;
    }

    if (character === '"') {
      index = tokenizeDoubleQuotedString(source, index, push);
      expectsCommand = false;
      continue;
    }

    if (character === "'") {
      const end = quotedEnd(source, index, character);
      push("string", source.slice(index, end));
      index = end;
      expectsCommand = false;
      continue;
    }

    if (character === "$") {
      const end = variableEnd(source, index);
      push("variable", source.slice(index, end));
      index = end;
      expectsCommand = false;
      continue;
    }

    if (character === "\\" && source[index + 1] === "\n") {
      push("operator", "\\\n");
      index += 2;
      continue;
    }

    const operator = operatorAt(source, index);
    if (operator) {
      push("operator", operator);
      index += operator.length;
      if (COMMAND_SEPARATORS.has(operator)) expectsCommand = true;
      continue;
    }

    const start = index;
    while (index < source.length) {
      const current = source[index] ?? "";
      if (/\s/u.test(current) || current === "'" || current === '"' || current === "$") break;
      if (current === "#" && canStartComment(source, index)) break;
      if (current === "\\" && source[index + 1] === "\n") break;
      if (operatorAt(source, index)) break;
      index += 1;
    }

    if (index === start) {
      push("plain", character);
      index += 1;
      continue;
    }

    const word = source.slice(start, index);
    const kind = classifyWord(word, expectsCommand);
    push(kind, word);
    if (kind !== "assignment") expectsCommand = false;
    if (kind === "keyword" && /^(?:do|elif|else|then)$/u.test(word)) {
      expectsCommand = true;
    }
  }

  return tokens;
}

function classifyWord(word: string, expectsCommand: boolean): CommandTokenKind {
  if (SHELL_KEYWORDS.has(word)) return "keyword";
  if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(word)) return "assignment";
  if (expectsCommand) return "command";
  if (/^--?[A-Za-z0-9]/u.test(word)) return "option";
  if (/^(?:\.{0,2}\/|~\/|\/)/u.test(word) || word.includes("/")) return "path";
  return "plain";
}

function quotedEnd(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === "\\" && quote === '"') {
      index = Math.min(source.length, index + 2);
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function tokenizeDoubleQuotedString(
  source: string,
  start: number,
  push: (kind: CommandTokenKind, text: string) => void,
): number {
  let index = start + 1;
  let stringStart = start;
  while (index < source.length) {
    const character = source[index] ?? "";
    if (character === "\\") {
      index = Math.min(source.length, index + 2);
      continue;
    }
    if (character === "$") {
      push("string", source.slice(stringStart, index));
      const end = variableEnd(source, index);
      push("variable", source.slice(index, end));
      index = end;
      stringStart = index;
      continue;
    }
    if (character === '"') {
      index += 1;
      push("string", source.slice(stringStart, index));
      return index;
    }
    index += 1;
  }
  push("string", source.slice(stringStart));
  return source.length;
}

function variableEnd(source: string, start: number): number {
  const next = source[start + 1];
  if (next === "{") return balancedEnd(source, start + 1, "{", "}");
  if (next === "(") return balancedEnd(source, start + 1, "(", ")");
  if (next && /[A-Za-z_]/u.test(next)) {
    let index = start + 2;
    while (index < source.length && /[A-Za-z0-9_]/u.test(source[index] ?? "")) index += 1;
    return index;
  }
  return Math.min(source.length, start + 2);
}

function balancedEnd(
  source: string,
  openIndex: number,
  open: string,
  close: string,
): number {
  let depth = 0;
  let quote: string | null = null;
  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (quote) {
      if (character === "\\" && quote === '"') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

function operatorAt(source: string, index: number): string | undefined {
  return OPERATORS.find((operator) => source.startsWith(operator, index));
}

function canStartComment(source: string, index: number): boolean {
  if (index === 0) return true;
  return /[\s;&|()]/u.test(source[index - 1] ?? "");
}

function isBashLabel(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === "bash" || normalized === "shell";
}
