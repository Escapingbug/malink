"use client";

import React, { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./dialogFocus";
import { SettingsIcon } from "./SettingsIcon";

const inertOwners = new Map<HTMLElement, { count: number; original: boolean }>();
let scrollOwners = 0;
let originalOverflow = "";

/** Each management task has its own surface, never an expanded control dump. */
export function ComputerActionPanel({ title, subtitle, icon = "›", children, open: controlledOpen,
  onOpenChange, danger = false, trigger = true }: {
  title: string; subtitle?: string; icon?: string; children: ReactNode;
  open?: boolean; onOpenChange?(open: boolean): void; danger?: boolean; trigger?: boolean;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (value: boolean) => { setLocalOpen(value); onOpenChange?.(value); };
  return <>
    {trigger && <button type="button" className={`computer-action-entry${danger ? " is-danger" : ""}`} onClick={() => setOpen(true)} aria-haspopup="dialog">
      <span className="computer-action-icon" aria-hidden="true"><SettingsIcon name={icon === "✎" ? "edit" : icon === "⟳" ? "refresh" : icon === "?" ? "help" : icon === "−" ? "remove" : "next"}/></span>
      <span><strong>{title}</strong>{subtitle && <small>{subtitle}</small>}</span>
      <span aria-hidden="true">›</span>
    </button>}
    {open && <ComputerActionDialog title={title} onClose={() => setOpen(false)}>{children}</ComputerActionDialog>}
  </>;
}

export function ComputerActionDialog({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const id = useId();
  useDialogFocus({ open: true, containerRef: ref, initialFocusRef: back, onEscape: onClose });
  useEffect(() => {
    const surface = ref.current?.parentElement;
    if (!surface) return;
    const siblings = [...document.body.children].filter((element): element is HTMLElement => element instanceof HTMLElement && element !== surface);
    siblings.forEach(element => {
      const owner = inertOwners.get(element) ?? { count: 0, original: element.inert };
      owner.count += 1;
      inertOwners.set(element, owner);
      element.inert = true;
    });
    if (scrollOwners++ === 0) originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      siblings.forEach(element => {
        const owner = inertOwners.get(element);
        if (owner && --owner.count === 0) { element.inert = owner.original; inertOwners.delete(element); }
      });
      if (--scrollOwners === 0) document.body.style.overflow = originalOverflow;
    };
  }, []);
  if (typeof document === "undefined") return null;
  return createPortal(<div className="computer-action-backdrop" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={ref} className="computer-action-dialog" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
      <header><button ref={back} type="button" onClick={onClose} aria-label={`Back from ${title}`}>←</button><h2 id={id}>{title}</h2><button type="button" onClick={onClose} aria-label={`Close ${title}`}>×</button></header>
      <div className="computer-action-body">{children}</div>
    </section>
  </div>, document.body);
}
