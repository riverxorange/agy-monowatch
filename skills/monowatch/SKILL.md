---
name: monowatch
description: Open the monowatch side panel to show Antigravity usage, including equivalent API cost, subscription payback, per-model cache hit rate, TTFT and tok/s, context window usage and compactions, subagent costs, runtime events, and model routing. Use when the user mentions monowatch or asks how many tokens, how much money, how much context or what speed a conversation, project or model is using.
---

# monowatch

monowatch is a side panel (sidecar `monowatch/monitor_board`) that reads Antigravity's local conversation data without modifying it and shows usage and cost. This skill only covers how to point the user to the panel. Read the numbers in the panel; do not estimate them yourself.

## Opening the panel

Put one pill on its own line. Do not emit more than one monowatch pill per reply.

```markdown
[monowatch](sidecar://monowatch/monitor_board/)
```

Optional query parameters:

| Parameter | Values | Effect |
| :--- | :--- | :--- |
| `tab` | `overview`, `conversation`, `project`, `cli`, `cloud`, `canary` | Opens a specific tab (`cloud` = Events, `canary` = Routing) |
| `thread` | a conversation ID | Opens that conversation's detail view |
| `lang` | `en`, `zh` | Forces the UI language for this session |

Example: the current conversation's detail view.

```markdown
[monowatch](sidecar://monowatch/monitor_board/?thread=<conversation-id>)
```

## Managing the plugin

- To enable, disable or inspect the plugin, link to `[monowatch](customization://monowatch)`. Do not edit `~/.gemini/config/config.json` by hand.
- To update, the user can click **Update** in the panel header. If `~/.gemini/config/plugins/monowatch/.git` exists, you may also run `git -C ~/.gemini/config/plugins/monowatch pull --ff-only`. The panel reloads itself; Antigravity does not need a restart.
- Custom prices go in `<appData>/sidecar_data/monowatch/monitor_board/data/pricing_override.json`. The format is described in `docs/TELEMETRY_SPEC.md` in the plugin directory.
