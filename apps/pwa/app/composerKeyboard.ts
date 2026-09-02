export type ComposerEnterAction = "send" | "newline" | "ignore";

export function isDesktopBrowserUserAgent(
  userAgent: string,
  maxTouchPoints = 0,
): boolean {
  const mobileOperatingSystem = /Android|iPhone|iPad|iPod/i.test(userAgent);
  const desktopModeIpad = /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
  return !mobileOperatingSystem && !desktopModeIpad;
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
