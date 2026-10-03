#!/usr/bin/env bash
set -euo pipefail

readonly repository="reggie-db/dbx-tools"
readonly workflow="release.yml"
readonly registry="https://registry.npmjs.org"
readonly release_tag="v0.9.19"
readonly release_version="0.9.19"
readonly release_sha="a426a0dbf8aa0acfed0ba8566101dc1cdad38d1b"
readonly expected_package_count="63"
readonly npm_version="11.19.0"

readonly cutover_packages=(
  "@dbx-tools/appkit-mastra@0.9.19"
  "@dbx-tools/appkit-web-search@0.9.19"
  "@dbx-tools/cli-tunnel@0.9.19"
  "@dbx-tools/cli@0.9.19"
  "@dbx-tools/databricks-zerobus@0.9.19"
  "@dbx-tools/projen@0.9.19"
  "@dbx-tools/search@0.9.19"
  "@dbx-tools/teams@0.9.19"
  "@dbx-tools/tunnel@0.9.19"
)

npm_cmd() {
  bunx "npm@${npm_version}" "$@"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  }
}

trust_matches() {
  jq -e --arg repository "$repository" --arg workflow "$workflow" '
    any(
      .. | objects;
      (((.type? // .provider? // "") | tostring | ascii_downcase) == "github") and
      ((.repository? // .repo? // "") == $repository) and
      ((.file? // .workflow? // .workflowFile? // "") == $workflow) and
      (
        (.permissions? // []) as $permissions |
        if ($permissions | type) == "array" then
          any($permissions[]; . == "createPackage" or . == "publish")
        elif ($permissions | type) == "object" then
          ($permissions.createPackage == true or $permissions.publish == true)
        else
          false
        end
      )
    )
  ' >/dev/null
}

for command in bash bun gh jq; do
  require_command "$command"
done

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT

gh release download "$release_tag" \
  --repo "$repository" \
  --pattern release-manifest.json \
  --dir "$temporary_directory"

manifest="$temporary_directory/release-manifest.json"
jq -e \
  --arg tag "$release_tag" \
  --arg version "$release_version" \
  --arg sha "$release_sha" \
  '.tag == $tag and .version == $version and .gitSha == $sha' \
  "$manifest" >/dev/null

packages="$temporary_directory/npm-packages.txt"
jq -r '.artifacts[] | select(.kind == "npm") | .packageName' "$manifest" | sort -u >"$packages"
package_count="$(wc -l <"$packages" | tr -d '[:space:]')"
if [[ "$package_count" != "$expected_package_count" ]]; then
  printf 'Expected %s npm packages, found %s\n' "$expected_package_count" "$package_count" >&2
  exit 1
fi

printf 'Authenticating to npm with web login and 2FA.\n'
npm_cmd login --auth-type=web --registry="$registry"

stages_json="$temporary_directory/stages.json"
npm_cmd stage list --json --registry="$registry" >"$stages_json"

approved_stage_count=0
for spec in "${cutover_packages[@]}"; do
  package="${spec%@*}"
  version="${spec##*@}"
  stage_count="$(
    jq --arg package "$package" --arg version "$version" \
      '[.[] | select(.packageName == $package and .version == $version)] | length' \
      "$stages_json"
  )"
  if [[ "$stage_count" -gt 1 ]]; then
    printf 'Found multiple staged releases for %s\n' "$spec" >&2
    exit 1
  fi
  if [[ "$stage_count" == "1" ]]; then
    stage_id="$(
      jq -r --arg package "$package" --arg version "$version" \
        '.[] | select(.packageName == $package and .version == $version) | .id' \
        "$stages_json"
    )"
    printf 'Approving %s (%s)\n' "$spec" "$stage_id"
    npm_cmd stage approve "$stage_id" --registry="$registry"
    approved_stage_count=$((approved_stage_count + 1))
    continue
  fi

  published_version="$(npm_cmd view "$spec" version --json --registry="$registry")"
  if [[ "$(jq -r . <<<"$published_version")" != "$version" ]]; then
    printf 'Neither a stage nor the published version exists for %s\n' "$spec" >&2
    exit 1
  fi
  printf 'Already published: %s\n' "$spec"
done

while IFS= read -r package; do
  trust_json="$temporary_directory/trust.json"
  npm_cmd trust list "$package" --json --registry="$registry" >"$trust_json"
  if trust_matches <"$trust_json"; then
    printf 'Trusted publisher already configured for %s\n' "$package"
    continue
  fi
  if [[ "$(jq 'length' "$trust_json")" != "0" ]]; then
    printf 'Conflicting trusted publisher configuration for %s:\n' "$package" >&2
    cat "$trust_json" >&2
    exit 1
  fi

  printf 'Configuring trusted publisher for %s\n' "$package"
  npm_cmd trust github "$package" \
    --repo "$repository" \
    --file "$workflow" \
    --allow-publish \
    --registry="$registry" \
    --yes
  sleep 2

  npm_cmd trust list "$package" --json --registry="$registry" >"$trust_json"
  if ! trust_matches <"$trust_json"; then
    printf 'Trusted publisher verification failed for %s\n' "$package" >&2
    cat "$trust_json" >&2
    exit 1
  fi
done <"$packages"

npm_cmd stage list --json --registry="$registry" >"$stages_json"
for spec in "${cutover_packages[@]}"; do
  package="${spec%@*}"
  version="${spec##*@}"
  if jq -e --arg package "$package" --arg version "$version" \
    '.[] | select(.packageName == $package and .version == $version)' \
    "$stages_json" >/dev/null; then
    printf 'Stage still pending for %s\n' "$spec" >&2
    exit 1
  fi

  published_version="$(npm_cmd view "$spec" version --json --registry="$registry")"
  if [[ "$(jq -r . <<<"$published_version")" != "$version" ]]; then
    printf 'Published version verification failed for %s\n' "$spec" >&2
    exit 1
  fi
done

printf 'Approved %s pending stages, verified %s cutover versions, and verified %s trusted publishers.\n' \
  "$approved_stage_count" "${#cutover_packages[@]}" "$package_count"
