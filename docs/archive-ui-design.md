# Archive UI: user flow and verification

## Scenarios and choices

1. **Daily work on a phone:** conversation content is the primary surface. Remove the persistent Active/Archived controls and count. Keep archive navigation in the existing conversation-list overflow menu. The archive destination reuses the existing header height and replaces the title with an explicit Back control and “已归档会话”.
2. **Put completed work away:** the session menu describes archive as retaining history and files. The list menu calls multi-selection “批量归档会话…” to explain why the user is selecting items. Running sessions explain that the agent must be stopped first.
3. **Find and resume work:** the archive destination contains only projects with actual matching archived sessions, supports search and the existing computer filter, and labels rows as archived. Empty/search states explain what is missing and how to return. Archive help explains shared workspace scope and distinguishes Agent History from retained archives. Opening an archive allows history browsing; a restore control replaces the composer, rather than adding another permanent chat toolbar. Successful restore returns to the normal list and opens the same conversation.
4. **Delete intentionally:** use the existing accessible confirmation dialog rather than browser confirm. Explain that deletion removes the session across devices and cannot be undone from Archived. Mention scratch files only for scratch sessions. The confirmation suggests archive when the intent is merely to tidy the list.
5. **Android Back:** close the foremost dialog/menu, return from chat to the archive list, close search, then return from the archive list to normal conversations. Opening the archive destination clears stale search and bulk selections.

## Verification

- Browser workflow fixture uses the production archive heading/help/empty/restore components, production delete dialog and CSS, with clearly labeled sample sessions. It covers menu entry, unchanged header height, history-only mode, restore, delete cancellation, search, native Back and empty state at 320, 360, 390, 768 and 1280px widths.
- Screenshots were visually inspected; this is browser viewport simulation, not acceptance on a physical Android device or a live Matrix account.
- PWA production build, TypeScript checks and targeted navigation/lifecycle/selection regressions are run.

## Data limitation

The previous UI rendered empty project groups in the archive view, which made its meaning less clear. That presentation bug is fixed. The actual source of the user's unexpectedly large archived count has not been verified against their client projection; no archived sessions or migration state are removed as part of this UI redesign.
