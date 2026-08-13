---
name: format-databricks-bundle-yaml
description: Pointer to the global format-databricks-bundle-yaml skill. Use when creating or editing databricks.yml or resources/*.yml, configuring the direct deployment engine, binding app resources, or migrating a bundle off the Terraform engine.
---

# Format Databricks Bundle YAML

This skill now lives globally at `~/.cursor/skills/format-databricks-bundle-yaml`
so every repository shares one copy. Load that skill instead of maintaining
bundle guidance here.

It covers bundle YAML shape for the direct deployment engine, `variables` versus
`config.env`, `value` versus `value_from`, app/warehouse/secret/Lakebase resource
bindings, `prevent_destroy`, adopting a resource that fails with
`409 ALREADY_EXISTS`, Terraform-to-direct migration, and the pre-deploy review
checklist. It also names the prerequisite skills to load first: `databricks-core`,
`databricks-dabs`, `databricks-lakebase-autoscale-bundle`, and the product skill
for each resource in the bundle.

Repository-specific bundle conventions belong in `AGENTS.md`, not in a second
copy of this skill.
