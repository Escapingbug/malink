import React from "react";
import { RefreshCw, Pencil, CircleHelp, Minus, ChevronRight, Check, Monitor, ArrowLeft, X } from "lucide-react";

/** Settings controls use one stroke, size and baseline, never font glyphs. */
export function SettingsIcon({ name, className }: {
  name: "refresh" | "edit" | "help" | "remove" | "next" | "check" | "computer" | "back" | "close";
  className?: string;
}) {
  const Icon = { refresh: RefreshCw, edit: Pencil, help: CircleHelp, remove: Minus,
    next: ChevronRight, check: Check, computer: Monitor, back: ArrowLeft, close: X }[name];
  return <Icon className={"settings-icon" + (className ? " " + className : "")} size={16} strokeWidth={1.75} aria-hidden="true"/>;
}
