"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  MalinkArtifactReference,
  MalinkAttachment,
} from "@malink/protocol";
import type { MalinkClient } from "./client/MalinkClient";
import { writeClipboardTextWithTimeout } from "./uiClipboard";

const ARTIFACT_SCHEME = "malink-artifact:";
const MAX_INLINE_TEXT_PREVIEW_BYTES = 1024 * 1024;

type MarkdownContentProps = {
  content: string;
  artifactReferences?: MalinkArtifactReference[];
  attachments?: MalinkAttachment[];
  connection?: MalinkClient | null;
  onMaterializeArtifact?(
    reference: MalinkArtifactReference,
  ): Promise<"materialized" | "changed">;
};

function MarkdownCodeBlock({ children }: { children: ReactNode }) {
  const blockRef = useRef<HTMLPreElement>(null);
  const [copyState, setCopyState] = useState<
    "idle" | "copying" | "copied" | "failed"
  >("idle");

  async function copyCode() {
    const value = blockRef.current?.innerText ?? "";
    if (!value || copyState === "copying") return;
    setCopyState("copying");
    try {
      await writeClipboardTextWithTimeout(value);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    window.setTimeout(() => setCopyState("idle"), 1_600);
  }

  return (
    <div className="markdown-code-block">
      <button
        type="button"
        disabled={copyState === "copying"}
        onClick={() => void copyCode()}
      >
        {copyState === "copying"
          ? "Copying…"
          : copyState === "copied"
          ? "Copied"
          : copyState === "failed"
            ? "Copy failed"
            : "Copy"}
      </button>
      <pre ref={blockRef}>{children}</pre>
    </div>
  );
}

export function MarkdownContent({
  content,
  artifactReferences = [],
  attachments = [],
  connection = null,
  onMaterializeArtifact,
}: MarkdownContentProps) {
  const references = useMemo(
    () => new Map(artifactReferences.map(reference => [reference.id, reference])),
    [artifactReferences],
  );
  const attachmentMap = useMemo(
    () => new Map(attachments.map(attachment => [attachment.id, attachment])),
    [attachments],
  );

  function artifactControl(referenceId: string, label: ReactNode, image: boolean) {
    const reference = references.get(referenceId);
    if (!reference) return <span className="artifact-reference-error">Unavailable file reference</span>;
    return (
      <ArtifactReference
        reference={reference}
        attachment={attachmentMap.get(referenceId)}
        connection={connection}
        image={image}
        onMaterialize={onMaterializeArtifact}
      >
        {label}
      </ArtifactReference>
    );
  }

  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        urlTransform={(url) =>
          url.startsWith(ARTIFACT_SCHEME) ? url : defaultUrlTransform(url)
        }
        components={{
          pre({ children }) {
            return <MarkdownCodeBlock>{children}</MarkdownCodeBlock>;
          },
          a({ children, href, ...props }) {
            const referenceId = artifactReferenceId(href);
            if (referenceId) return artifactControl(referenceId, children, false);
            return (
              <a
                {...props}
                href={href}
                rel="noopener noreferrer"
                target="_blank"
              >
                {children}
              </a>
            );
          },
          img({ alt, src }) {
            const referenceId = artifactReferenceId(src);
            if (referenceId) {
              return artifactControl(referenceId, alt || "Referenced image", true);
            }
            // Remote Markdown images stay in the browser pipeline. Application
            // attachments always use verified, short-lived blob URLs below.
            return <img alt={alt ?? ""} src={src} />;
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function ArtifactReference({
  reference,
  attachment,
  connection,
  image,
  onMaterialize,
  children,
}: {
  reference: MalinkArtifactReference;
  attachment?: MalinkAttachment;
  connection: MalinkClient | null;
  image: boolean;
  onMaterialize?(
    reference: MalinkArtifactReference,
  ): Promise<"materialized" | "changed">;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const [waitingForAttachment, setWaitingForAttachment] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);

  useEffect(() => () => {
    if (preview?.url) URL.revokeObjectURL(preview.url);
  }, [preview]);

  useEffect(() => {
    if (!image || !attachment || !connection || preview || busy) return;
    void openAttachment(attachment, connection, setBusy, setError, setPreview);
  }, [attachment, busy, connection, image, preview]);

  useEffect(() => {
    if (!waitingForAttachment || !attachment || !connection || busy) return;
    void openAttachment(
      attachment,
      connection,
      setBusy,
      setError,
      setPreview,
    ).finally(() => setWaitingForAttachment(false));
  }, [attachment, busy, connection, waitingForAttachment]);

  async function confirm() {
    if (busy || !connection) return;
    setError(null);
    if (attachment) {
      await openAttachment(attachment, connection, setBusy, setError, setPreview);
      return;
    }
    if (!onMaterialize) {
      setError("This client cannot request the referenced file.");
      return;
    }
    setBusy(true);
    setWaitingForAttachment(true);
    try {
      const status = await onMaterialize(reference);
      if (status === "changed") {
        setWaitingForAttachment(false);
        setError("The file changed. Review the updated size and confirm again.");
      }
    } catch (materializeError) {
      setWaitingForAttachment(false);
      setError(formatArtifactError(materializeError));
    } finally {
      setBusy(false);
    }
  }

  if (image && preview?.kind === "image" && preview.url) {
    return <img className="artifact-inline-image" src={preview.url} alt={String(children)} />;
  }

  return (
    <span className={`artifact-reference ${image ? "is-image" : "is-file"}`}>
      <button
        type="button"
        className="artifact-reference-trigger"
        aria-expanded={expanded}
        onClick={() => setExpanded(current => !current)}
      >
        {image ? "▧" : "▤"} {children}
      </button>
      {expanded && (
        <span className="artifact-reference-details">
          <b>{reference.name}</b>
          <span>{reference.relativePath}</span>
          <span>
            {reference.mimeType} · {formatArtifactSize(reference.size)} · {formatArtifactTime(reference.modifiedAt)}
          </span>
          <button
            type="button"
            disabled={!connection || busy || waitingForAttachment}
            onClick={() => void confirm()}
          >
            {busy || waitingForAttachment
              ? attachment ? "Opening…" : "Preparing…"
              : image
                ? attachment ? "Open image" : "Upload and show image"
                : attachment ? "Open file" : "Upload and open file"}
          </button>
          {error && <small className="artifact-reference-error">{error}</small>}
        </span>
      )}
      {preview && preview.kind !== "image" && (
        <ArtifactPreviewView preview={preview} name={reference.name} onClose={() => setPreview(null)} />
      )}
    </span>
  );
}

type ArtifactPreview =
  | { kind: "image" | "pdf" | "audio" | "video"; url: string }
  | { kind: "text"; text: string }
  | { kind: "downloaded" };

async function openAttachment(
  attachment: MalinkAttachment,
  connection: MalinkClient,
  setBusy: (busy: boolean) => void,
  setError: (error: string | null) => void,
  setPreview: (preview: ArtifactPreview | null) => void,
) {
  setBusy(true);
  setError(null);
  try {
    const blob = await connection.downloadAttachment(attachment);
    if (
      isTextPreview(attachment.mimeType)
      && blob.size <= MAX_INLINE_TEXT_PREVIEW_BYTES
    ) {
      setPreview({ kind: "text", text: await blob.text() });
      return;
    }
    const kind = previewKind(attachment.mimeType);
    if (kind) {
      setPreview({ kind, url: URL.createObjectURL(blob) });
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = attachment.name;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setPreview({ kind: "downloaded" });
  } catch (downloadError) {
    setError(formatArtifactError(downloadError));
  } finally {
    setBusy(false);
  }
}

function ArtifactPreviewView({
  preview,
  name,
  onClose,
}: {
  preview: Exclude<ArtifactPreview, { kind: "image" }>;
  name: string;
  onClose(): void;
}) {
  return (
    <span className="artifact-preview">
      <span className="artifact-preview-header">
        <b>{name}</b>
        <button type="button" onClick={onClose}>Close</button>
      </span>
      {preview.kind === "text" && <span className="artifact-preview-text">{preview.text}</span>}
      {preview.kind === "pdf" && <iframe sandbox="" src={preview.url} title={name} />}
      {preview.kind === "audio" && <audio src={preview.url} controls />}
      {preview.kind === "video" && <video src={preview.url} controls />}
      {preview.kind === "downloaded" && <span>The file was downloaded for the system to open.</span>}
    </span>
  );
}

function artifactReferenceId(value: string | undefined): string | null {
  if (!value?.startsWith(ARTIFACT_SCHEME)) return null;
  const id = value.slice(ARTIFACT_SCHEME.length);
  return id && /^[A-Za-z0-9_-]+$/u.test(id) ? id : null;
}

function isTextPreview(mimeType: string): boolean {
  return mimeType.startsWith("text/")
    || mimeType === "application/json"
    || mimeType.endsWith("+json");
}

function previewKind(mimeType: string): "image" | "pdf" | "audio" | "video" | null {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType.startsWith("audio/")) return "audio";
  if (mimeType.startsWith("video/")) return "video";
  return null;
}

function formatArtifactSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MiB`;
}

function formatArtifactTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatArtifactError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
