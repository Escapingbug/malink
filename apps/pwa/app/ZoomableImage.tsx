"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "./dialogFocus";
import { NATIVE_BACK_PRIORITY, useNativeBackHandler } from "./nativeBackNavigation";

/** Reuses the verified preview URL; the parent retains ownership of its lifetime. */
export function ZoomableImage({ src, alt, className }: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="image-preview-trigger" aria-label={`Enlarge image: ${alt}`}
      title="Click to enlarge" aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <img src={src} alt={alt} className={className} />
      <span className="image-preview-badge" aria-hidden="true">⤢</span>
    </button>
    {open && <ImageViewer key={src} src={src} alt={alt} onClose={() => setOpen(false)} />}
  </>;
}

function ImageViewer({ src, alt, onClose }: { src: string; alt: string; onClose(): void }) {
  const [originalSize, setOriginalSize] = useState(false);
  const [failed, setFailed] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useDialogFocus({ open: true, containerRef: dialog, initialFocusRef: close, onEscape: onClose });
  useNativeBackHandler(true, () => { onClose(); return true; }, NATIVE_BACK_PRIORITY.nestedModal);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, []);
  return createPortal(
    <section ref={dialog} className="image-viewer" role="dialog" aria-modal="true"
      aria-label={`Image preview: ${alt}`} tabIndex={-1}>
      <header className="image-viewer-toolbar">
        <span title={alt}>{alt}</span>
        <button type="button" disabled={failed} aria-pressed={originalSize}
          onClick={() => setOriginalSize(value => !value)}>
          {originalSize ? "Fit to screen" : "Original size"}
        </button>
        <button ref={close} type="button" aria-label="Close image preview" onClick={onClose}>Close</button>
      </header>
      <div className={`image-viewer-stage${originalSize ? " is-original-size" : ""}`}
        onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
        {failed ? <p role="alert">This image could not be displayed. Close the viewer and try loading the preview again.</p>
          : <img src={src} alt={alt} onError={() => setFailed(true)} />}
      </div>
    </section>, document.body,
  );
}
