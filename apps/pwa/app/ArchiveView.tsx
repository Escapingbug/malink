"use client";

export function ArchiveListHeading({ archived, onBack }: { archived: boolean; onBack(): void }) {
  return archived ? <div className="archive-list-heading">
    <button type="button" onClick={onBack} aria-label="返回会话列表" title="返回会话列表">‹</button>
    <h1>已归档会话</h1>
  </div> : <div><span className="eyebrow">Workspace</span><h1>Malink</h1></div>;
}

export function ArchiveListHelp() {
  return <details className="archive-list-help">
    <summary>归档会话是什么？</summary>
    <p>归档用于收起暂时不用的会话，保留消息和文件。打开会话后，点「恢复并继续」即可接着使用。</p>
    <p>此列表显示当前工作区同步的归档会话，按电脑和项目分组；不是已删除会话的回收站。已删除的会话在 Agent 仍保留历史时，可从会话列表 ⋯ →「Agent 历史记录」重建并恢复历史，耗时较长。</p>
  </details>;
}

export function ArchiveEmptyState({ searching, onBack }: { searching: boolean; onBack(): void }) {
  return <div className="empty-search empty-search-action archive-empty">
    <strong>{searching ? "没有找到匹配的归档会话" : "这里还没有归档会话"}</strong>
    <small>{searching ? "试试其他关键词，或切换电脑筛选。" : "当前范围内没有归档会话。完成工作后，可在会话菜单中选择「归档会话」，需要时再回来恢复。"}</small>
    <button type="button" onClick={onBack}>返回会话列表</button>
  </div>;
}

export function ArchivedConversationNotice({ busy, available, onRestore }: {
  busy: boolean; available: boolean; onRestore(): void;
}) {
  return <div className="archived-conversation-notice">
    <div><strong>已归档 · 仅浏览</strong><p>消息和文件已保留，恢复后可继续对话。</p>
      {!available && <small>电脑连接后即可恢复。</small>}</div>
    <button type="button" className="primary-button" disabled={busy || !available} aria-busy={busy} onClick={onRestore}>
      {busy ? "正在处理…" : "恢复并继续"}
    </button>
  </div>;
}
