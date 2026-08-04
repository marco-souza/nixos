---
name: settings
description: Read and modify Pi settings (global or per-project) based on user instructions. Knows the settings schema, file locations, and how to apply changes.
---

# Settings

Manages Pi configuration files. Use this when the user asks to change how Pi behaves — theme, models, retry behavior, compaction, editor, etc.

## Locations

| Scope                | File                              | Notes                              |
| -------------------- | --------------------------------- | ---------------------------------- |
| **Global**           | `~/.pi/agent/settings.json`       | Applies to all projects            |
| **Project**          | `.pi/settings.json`               | Overrides global per-project       |
| **Stow (this repo)** | `stow/pi/.pi/agent/settings.json` | Dotfiles-managed version of global |

When working inside this dotfiles repo, always edit `stow/pi/.pi/agent/settings.json` and re-apply with `stow_config pi` so the change is version-controlled.

## Settings Reference

Full docs: <https://pi.dev/docs/latest/settings>

### Common settings

| Key                    | Type     | Description                                                    |
| ---------------------- | -------- | -------------------------------------------------------------- |
| `defaultProvider`      | string   | Default provider (e.g. `"opencode"`)                           |
| `defaultModel`         | string   | Default model ID                                               |
| `defaultThinkingLevel` | string   | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` |
| `hideThinkingBlock`    | boolean  | Hide thinking blocks in output                                 |
| `theme`                | string   | `"dark"`, `"light"`, or custom theme name                      |
| `externalEditor`       | string   | Command for Ctrl+G (e.g. `"neovim"`)                           |
| `quietStartup`         | boolean  | Hide startup header                                            |
| `enabledModels`        | string[] | Models for Ctrl+P cycling                                      |
| `terminal.showImages`  | boolean  | Show images in terminal                                        |
| `retry.maxRetries`     | number   | Auto-retry attempts on errors                                  |
| `compaction.enabled`   | boolean  | Auto-compact long sessions                                     |

## Reading current settings

```bash
# Global (or stow-managed)
cat ~/.pi/agent/settings.json

# Project-level
cat .pi/settings.json 2>/dev/null || echo "No project settings"
```

## Modifying settings

1. Read the current file
2. Make the requested change
3. Validate JSON syntax
4. If working in the dotfiles repo, re-apply with:

   ```bash
   source scripts/useful-functions.sh && stow_config pi
   ```

5. Inform the user the change is active (restart Pi if needed)

## Creating a project-level override

When a user wants settings specific to one project:

```bash
mkdir -p .pi
cat > .pi/settings.json << 'EOF'
{
  "defaultModel": "claude-sonnet-4-20250514",
  "defaultThinkingLevel": "high"
}
EOF
```
