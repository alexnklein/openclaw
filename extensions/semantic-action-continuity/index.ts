// Semantic action continuity plugin entrypoint registers workflow freshness hooks.
import { definePluginEntry } from "./api.js";
import {
  registerSemanticActionContinuityPlugin,
  semanticActionContinuityConfigSchema,
} from "./src/plugin.js";

export default definePluginEntry({
  id: "semantic-action-continuity",
  name: "Semantic Action Continuity",
  description: "Refreshes mutable workflow action snapshots before prompts and final replies.",
  configSchema: semanticActionContinuityConfigSchema,
  register: registerSemanticActionContinuityPlugin,
});
