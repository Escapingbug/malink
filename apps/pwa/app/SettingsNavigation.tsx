export type SettingsSection = "workspace" | "devices" | "computers" | "support";

const SETTINGS_SECTIONS: readonly [SettingsSection, string][] = [
  ["workspace", "Workspace"],
  ["devices", "Devices"],
  ["computers", "Computers"],
  ["support", "App & support"],
];

export function SettingsNavigation({
  activeSection,
  gatewayUpdateAvailableCount,
  onSelect,
}: {
  activeSection: SettingsSection;
  gatewayUpdateAvailableCount: number;
  onSelect(section: SettingsSection): void;
}) {
  return (
    <nav className="settings-navigation" aria-label="Settings sections">
      {SETTINGS_SECTIONS.map(([section, label]) => {
        const updateCount = section === "computers"
          ? gatewayUpdateAvailableCount
          : 0;
        const updateLabel = updateCount === 1
          ? "1 Gateway software update available"
          : `${updateCount} Gateway software updates available`;
        return (
          <button
            key={section}
            type="button"
            className={activeSection === section ? "is-active" : ""}
            aria-current={activeSection === section ? "page" : undefined}
            onClick={() => onSelect(section)}
          >
            <span>{label}</span>
            {updateCount > 0 && (
              <b aria-label={updateLabel} title={updateLabel}>
                {updateCount}
              </b>
            )}
          </button>
        );
      })}
    </nav>
  );
}
