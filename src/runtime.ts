import type { PluginRuntime } from "openclaw/plugin-sdk/core";

let runtime: PluginRuntime | null = null;

export function setNexusRuntime(r: PluginRuntime): void {
  runtime = r;
}

export function getNexusRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Nexus runtime not initialized - plugin not registered");
  }
  return runtime;
}
