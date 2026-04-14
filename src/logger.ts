/**
 * Minimal logger interface for the Nexus plugin.
 *
 * Matches the shape of OpenClaw's PluginLogger so callers can pass
 * `ctx.log` directly. Falls back to console when no logger is injected.
 */

export interface NexusLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** Default logger that writes to console (used when no OpenClaw logger is available). */
export const consoleLogger: NexusLogger = {
  info: (msg) => console.log(msg),
  warn: (msg) => console.warn(msg),
  error: (msg) => console.error(msg),
};
