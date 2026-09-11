# Gateway settings management

Computer rows show identity, availability and a short software summary. They no
longer repeat the reported build or a paragraph explaining workspace management.
An online updatable computer with no ongoing update exposes Update directly.
The action uses the same guarded per-node update handler as expanded settings.

Expanded management shows a concise update section and one recommended action.
Version identifiers, execution tracks, status timestamps, maintenance sessions,
cleanup and retained-version controls are behind a closed advanced disclosure.
Recovery requiring intervention has an explicit Review recovery button that opens
these controls. Restart, rename, diagnostics and removal keep their existing
separate disclosure and safety confirmations.

No new transport commands or automatic updates are introduced. Preparing a
release still uses the existing supervisor transaction. When that transaction
requires separate installation consent, settings show Ready to install and an
Install when idle action, rather than falsely promising automatic installation.
True single-consent automatic promotion requires a separate persisted update
intent design; hiding that remaining consent step would be unsafe.

Browser fixture coverage exercises mobile/desktop disclosure, update callback,
maintenance navigation and retained-version confirmation. These fixture checks
are UI integration tests, not live Matrix or Android acceptance.
