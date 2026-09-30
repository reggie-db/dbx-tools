/** GitHub repository identity used by release preparation. */
export interface GithubRepositoryIdentity {
  hostname: string;
  owner: string;
  repository: string;
}

/** Parse a GitHub repository URL without treating its owner as the authenticated actor. */
export function githubRepositoryIdentity(repositoryUrl: string): GithubRepositoryIdentity {
  const url = new URL(repositoryUrl);
  const [owner, name] = url.pathname.split("/").filter(Boolean);
  if (!owner || !name) {
    throw new Error(`Cannot determine GitHub repository identity from ${repositoryUrl}`);
  }
  return {
    hostname: url.hostname,
    owner,
    repository: name.replace(/\.git$/, ""),
  };
}

/** Ask GitHub CLI for the current actor's token on the repository host. */
export function githubTokenArguments(hostname: string): string[] {
  return ["auth", "token", "--hostname", hostname];
}

/** GitHub CLI token variable for a public, data-residency, or enterprise host. */
export function githubTokenEnvironmentName(hostname: string): "GH_TOKEN" | "GH_ENTERPRISE_TOKEN" {
  return hostname === "github.com" || hostname.endsWith(".ghe.com")
    ? "GH_TOKEN"
    : "GH_ENTERPRISE_TOKEN";
}

/** Host-qualified repository selector consumed by GitHub CLI. */
export function githubRepositorySpecifier(identity: GithubRepositoryIdentity): string {
  return `${identity.hostname}/${identity.owner}/${identity.repository}`;
}
