/** The env var holding the connector's connection id: a connector secret of this name sets it. */
export const CONNECTOR_ENV = "GITHUB_CONNECTOR";
/** Overrides the gateway's default URL. */
export const GATEWAY_URL_ENV = "GITHUB_GATEWAY_URL";

/**
 * The variables that let a process call GitHub through the gateway: the gateway takes the
 * connector id alone, so a process that holds it can publish, push or call the API as the runner
 * does. Only the runner's own code may hold them; no command or repo code is given them.
 */
export const CONNECTOR_VARS: readonly string[] = [
  CONNECTOR_ENV,
  GATEWAY_URL_ENV,
];

/** Only the connector variables of `env`, for the runner's own subcommand it starts. */
export function connectorOf(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const held: NodeJS.ProcessEnv = {};
  for (const name of CONNECTOR_VARS) {
    if (env[name] !== undefined) held[name] = env[name];
  }
  return held;
}

/** `env` less the connector variables: what a command or a plugin refresh may be started with. */
export function withoutConnector(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept = { ...env };
  for (const name of CONNECTOR_VARS) delete kept[name];
  return kept;
}

/**
 * Takes the connector variables out of `env` and returns them: after this no child process the
 * runner starts (git, `claude`, a hook) inherits them, and the runner hands them only to its own
 * code, which reads them from the returned object.
 */
export function takeConnector(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const taken: NodeJS.ProcessEnv = {};
  for (const name of CONNECTOR_VARS) {
    if (env[name] !== undefined) taken[name] = env[name];
    delete env[name];
  }
  return taken;
}
