import type { BaseProfile } from "@sky/shared";

/** The runner's variables a profile fills; reserved, so no secret or envVar overrides them. */
export const BASE_ENV_NAMES = [
  "SKY_STORE_REPO",
  "SKY_STORE_HOME",
  "SKY_STORE_LAYOUT",
  "SKY_SESSION_ENV",
  "SKY_CHECKS",
  "SKY_MCP_SERVERS",
] as const;

type Vars = (readonly [string, string])[];

/** What the store sync reads: where it syncs from and how the checkout is laid out. Empty without `storeRepo`. */
export function storeEnv(profile: BaseProfile | undefined): Vars {
  if (!profile?.storeRepo) return [];
  const layout = profile.storeLayout;
  return [
    ["SKY_STORE_REPO", profile.storeRepo],
    ["SKY_STORE_HOME", layout?.home ?? ".sky-store"],
    ...(layout ? [["SKY_STORE_LAYOUT", JSON.stringify(layout)] as const] : []),
  ];
}

/**
 * What a run's session reads: the store, extra session variables, the checks to run and the profile's
 * MCP servers. The servers hold `${NAME}`-style secret names, never values.
 */
export function runEnv(profile: BaseProfile | undefined): Vars {
  if (!profile) return [];
  return [
    ...storeEnv(profile),
    ...(Object.keys(profile.sessionEnv).length > 0
      ? [["SKY_SESSION_ENV", JSON.stringify(profile.sessionEnv)] as const]
      : []),
    ...(profile.checks.length > 0
      ? [["SKY_CHECKS", JSON.stringify(profile.checks)] as const]
      : []),
    ...(Object.keys(profile.mcpServers).length > 0
      ? [["SKY_MCP_SERVERS", JSON.stringify(profile.mcpServers)] as const]
      : []),
  ];
}
