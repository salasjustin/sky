import type { PluginRefresh, PluginVersion } from "@sky/shared";

const idOf = (plugin: PluginVersion) =>
  plugin.marketplace === null
    ? plugin.name
    : `${plugin.name}@${plugin.marketplace}`;

/**
 * A run's plugin record as lines a person reads: the refresh's outcome and duration, then one line
 * per plugin with the version before the refresh, after it and the one the session loaded. A plugin
 * the session loaded at another version than the refresh left installed says so on its line.
 */
export function pluginLines(plugins: PluginRefresh): string[] {
  const byName = new Map<
    string,
    { id: string; before?: string; after?: string; loaded?: string }
  >();
  const entry = (plugin: PluginVersion) => {
    const found = byName.get(plugin.name);
    if (found) {
      // a loaded plugin can't always name its marketplace; keep the one that can
      if (!found.id.includes("@")) found.id = idOf(plugin);
      return found;
    }
    const created = { id: idOf(plugin) };
    byName.set(plugin.name, created);
    return created as {
      id: string;
      before?: string;
      after?: string;
      loaded?: string;
    };
  };
  for (const p of plugins.before ?? []) entry(p).before = p.version;
  for (const p of plugins.after ?? []) entry(p).after = p.version;
  for (const p of plugins.loaded) entry(p).loaded = p.version;
  const reason = plugins.reason ? `: ${plugins.reason}` : "";
  const lines = [
    `plugins: ${plugins.outcome}${reason} (${(plugins.durationMs / 1000).toFixed(1)}s)`,
  ];
  // a list that was never read says so, rather than looking like a list with no plugins in it
  const unread = [
    plugins.before === null && "before",
    plugins.after === null && "after",
  ].filter((side) => side !== false);
  if (unread.length > 0)
    lines.push(`  not read: ${unread.join(" and ")} the refresh`);
  for (const { id, before, after, loaded } of byName.values()) {
    const behind =
      loaded !== undefined && after !== undefined && loaded !== after
        ? `  (the session loaded ${loaded}, not the installed ${after})`
        : "";
    lines.push(
      `  ${id}  before ${before ?? "-"}  after ${after ?? "-"}  loaded ${loaded ?? "-"}${behind}`,
    );
  }
  return lines;
}
