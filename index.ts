import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { nexusPlugin } from "./src/channel.js";
import { setNexusRuntime } from "./src/runtime.js";
import { CHANNEL_ID } from "./src/const.js";

const plugin = {
  id: "nexus-openclaw-plugin",
  name: "Nexus AI",
  description: "Nexus AI IM channel plugin for OpenClaw",
  configSchema: {
    type: "object" as const,
    additionalProperties: false,
    properties: {},
  },
  register(api: OpenClawPluginApi) {
    setNexusRuntime(api.runtime);
    api.registerChannel({ plugin: nexusPlugin });
  },
};

export default plugin;
