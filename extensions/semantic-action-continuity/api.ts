// Semantic action continuity API module exposes the plugin public contract.
export type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export {
  buildJsonPluginConfigSchema,
  definePluginEntry,
  type OpenClawPluginApi,
  type PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";
export type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
