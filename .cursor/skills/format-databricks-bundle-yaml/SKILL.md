---
name: format-databricks-bundle-yaml
description: Pointer to the global format-databricks-bundle-yaml skill. Use when creating or editing databricks.yml or resources/*.yml, configuring the direct deployment engine, binding app resources, or migrating a bundle off the Terraform engine.
---

# Format Databricks Bundle YAML

This skill now lives globally at `~/.cursor/skills/format-databricks-bundle-yaml`
so every repository shares one copy. Load that skill instead of maintaining
bundle guidance here.

It enforces the ownership boundary for bundled Databricks Apps: `app.yaml`
always owns the runtime command, while `databricks.yml` is the single source of
truth for deployed env vars and resource bindings. It also provides the
pre-deploy review checklist and names the prerequisite product skills.

Repository-specific bundle conventions belong in `AGENTS.md`, not in a second
copy of this skill.
