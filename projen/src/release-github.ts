import { json, object } from "@dbx-tools/shared-core";

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

/** One authenticated GitHub CLI account available on a repository host. */
export interface GithubAuthenticatedAccount {
  login: string;
  active: boolean;
}

/** Parse successful GitHub CLI accounts with the active account first. */
export function githubAuthenticatedAccounts(
  statusOutput: string,
  hostname: string,
): GithubAuthenticatedAccount[] {
  const status = json.parseRecord(statusOutput);
  const hosts = object.isRecord(status?.hosts) ? status.hosts : undefined;
  const entries = hosts?.[hostname];
  if (!Array.isArray(entries)) return [];
  return entries
    .flatMap((entry) => {
      if (!object.isRecord(entry) || entry.state !== "success" || typeof entry.login !== "string") {
        return [];
      }
      return [{ login: entry.login, active: entry.active === true }];
    })
    .filter(
      (account, index, accounts) =>
        accounts.findIndex((candidate) => candidate.login === account.login) === index,
    )
    .sort((left, right) => Number(right.active) - Number(left.active));
}

/** Ask GitHub CLI for one account token on the repository host. */
export function githubTokenArguments(hostname: string, user?: string): string[] {
  return ["auth", "token", "--hostname", hostname, ...(user ? ["--user", user] : [])];
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

/** GitHub REST path for the detected repository. */
export function githubRepositoryApiPath(identity: GithubRepositoryIdentity): string {
  return `repos/${identity.owner}/${identity.repository}`;
}
