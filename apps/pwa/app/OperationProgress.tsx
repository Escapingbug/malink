"use client";

import type { ReactNode } from "react";

export function OperationProgress({ className }: { className?: string }) {
  return (
    <span
      className={`operation-progress${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    >
      <i />
      <i />
      <i />
    </span>
  );
}

export function BusyActionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="busy-action-label">
      <OperationProgress />
      <span>{children}</span>
    </span>
  );
}
