/// <reference types="vite/client" />
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ArchiveListHeading, ArchiveListHelp, ArchiveEmptyState, ArchivedConversationNotice } from "../../app/ArchiveView";
import { SessionDeleteDialog } from "../../app/SessionDeleteDialog";
import { useNativeBackHandler } from "../../app/nativeBackNavigation";
import type { GatewaySessionSummary } from "../../app/gatewayState";
import "../../app/globals.css";
const names = ["登录流程优化", "整理发布说明", "定位 Android 同步问题"];
function Fixture() {
  const [archived, setArchived] = useState(false);
  const [menu, setMenu] = useState(false);
  const [searching, setSearching] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [restored, setRestored] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const empty = location.search.includes("empty");
  const change = (value: boolean) => { setArchived(value); setMenu(false); setSearching(false); setSearch(""); };
  useNativeBackHandler(true, () => { if (deleting) { setDeleting(false); return true; } if (selected) {setSelected(null); return true;} if (menu) {setMenu(false); return true;} if (searching) {setSearching(false);setSearch("");return true;} if (archived) {change(false);return true;} return false; });
  const titles = (archived ? empty ? [] : names.filter(n => !restored.includes(n)) : ["正在完善会话归档体验", ...restored]).filter(n => n.includes(search));
  const selectedArchived = selected !== null && names.includes(selected) && !restored.includes(selected);
  const restore = () => { setBusy(true); setTimeout(() => {setRestored(values => [...values, selected!]);change(false);setBusy(false);},200); };
  return <main style={{display:"flex",height:"100dvh",maxWidth:1100,margin:"auto"}}>
    <section className="session-panel" style={{display:selected ? "none" : "flex",maxWidth:480,position:"relative"}}>
      <header className="session-header"><ArchiveListHeading archived={archived} onBack={() => change(false)} />
        <div className={`session-header-actions ${archived ? "archive-header-actions" : ""}`}>
          <button className="mobile-history-button" aria-label="会话列表菜单" aria-expanded={menu} onClick={()=>setMenu(!menu)}>•••</button>
          <button className="mobile-search-button" aria-label="搜索会话" onClick={()=>setSearching(!searching)}>⌕</button>
          {!archived && <button className="round-button" aria-label="新建会话">+</button>}
        </div>
      </header>
      {menu && <div className="conversation-list-menu"><button onClick={()=>change(!archived)}>{archived ? "返回会话列表" : "已归档会话"}</button>{!archived && <button>批量归档会话…</button>}<button>Agent 历史记录…</button></div>}
      {searching && <label className="search-box search-box-open"><input aria-label="搜索会话" placeholder="搜索已归档会话" value={search} onChange={e=>setSearch(e.target.value)} /></label>}
      <div className="session-list">{archived && <ArchiveListHelp />}
        {titles.length > 0 && <section className="project-session-group"><div className="project-session-heading"><strong>Malink</strong><small style={{marginLeft:12}}>工作电脑 · 示例数据</small></div>
          {titles.map((title,i)=><button key={title} className="session-row" onClick={()=>setSelected(title)}><span className="session-avatar violet">M</span><span className="session-copy"><span className="session-title-line"><strong>{title}</strong><span className="session-title-meta"><time>{i ? "周三" : "昨天"}</time></span></span><span className="session-preview-line">{archived ? "已归档 · 点击查看历史" : "codex · 等待继续"}</span></span></button>)}</section>}
        {archived && !titles.length && <ArchiveEmptyState searching={Boolean(search)} onBack={()=>change(false)} />}
      </div>
    </section>
    {selected && <section style={{flex:1,padding:16,minWidth:0,display:"flex",flexDirection:"column",gap:12}}><button className="secondary-button" onClick={()=>setSelected(null)}>‹ 返回列表</button><h2>{selected}</h2>
      <article style={{flex:1,padding:16,borderRadius:12,background:"#f7f8fa"}}><strong>Agent · 示例消息</strong><p>任务已完成，检查结果和相关文件已保留。</p></article>
      {selectedArchived && <ArchivedConversationNotice busy={busy} available onRestore={restore} />}
      {!selectedArchived && <textarea aria-label="继续对话" placeholder="继续对话…" style={{marginTop:16,width:"100%"}} />}
      <button className="secondary-button" style={{marginTop:16}} onClick={()=>setDeleting(true)}>删除会话…</button>
      <SessionDeleteDialog session={deleting ? {id:"example",title:selected,status:selectedArchived?"archived":"idle",scope:"project"} as GatewaySessionSummary : null} busy={false} onClose={()=>setDeleting(false)} onConfirm={()=>{setDeleting(false);setSelected(null);}} />
    </section>}
  </main>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
