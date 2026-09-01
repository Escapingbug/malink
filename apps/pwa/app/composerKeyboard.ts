export type ComposerEnterAction = "send" | "newline" | "ignore";

export function isDesktopBrowserUserAgent(userAgent: string): boolean {
  return !/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
}

export function composerEnterAction(input: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  composing: boolean;
  desktopBrowser: boolean;
}): ComposerEnterAction {
  if (input.key !== "Enter" || input.composing) return "ignore";
  if (input.desktopBrowser) {
    return input.shiftKey || input.ctrlKey || input.metaKey || input.altKey
      ? "newline"
      : "send";
  }
  return input.ctrlKey || input.metaKey ? "send" : "newline";
}
