export declare const FINGERPRINT_SCHEMA = 4;
export declare const VERSION_SLOT_SCHEMA = 1;
export declare const VERSION_CAPACITY = 64;
/** Canonical TOML representation with workspace-owned release versions removed. */
export declare function normalizeManifest(text: string): string;
/** Canonical Cargo.lock representation with local package versions normalized. */
export declare function normalizeLockfile(text: string, workspaceVersion: string, packageNames?: ReadonlySet<string>): string;
/** Hash shared Cargo inputs plus selected or Cargo-discovered workspace sources. */
export declare function sourceHash(root: string, sources?: readonly string[], includeWorkspace?: boolean): string;
export declare function linkerIdentity(target: string): string;
export interface TargetKeyOptions {
    readonly rustSourceHash: string;
    readonly namespace?: string;
    readonly target: string;
    readonly targetConfig?: string;
    readonly toolchain?: string;
    readonly rustc?: string;
}
export declare function targetKey({ rustSourceHash, namespace, target, targetConfig, toolchain, rustc, }: TargetKeyOptions): string;
export interface FingerprintOptions {
    readonly root?: string;
    readonly output?: string;
    readonly check?: boolean;
    readonly targets: readonly string[];
    readonly toolchain?: string;
    readonly portable?: boolean;
    readonly sources?: readonly string[];
    readonly sourceOnly?: boolean;
    readonly namespace?: string;
}
export interface RustBuildFingerprint {
    readonly schemaVersion: number;
    readonly versionSlotSchema: number;
    readonly namespace: string;
    readonly rustSourceHash: string;
    readonly targets: Readonly<Record<string, string>>;
}
export declare function fingerprint({ root, output, check, targets, toolchain, portable, sources, sourceOnly, namespace, }: FingerprintOptions): RustBuildFingerprint;
export interface StampOptions {
    readonly objcopy?: string;
    readonly codesign?: string;
}
export declare function stamp(binary: string, version: string, options?: StampOptions): boolean;
export declare function stampTree(root: string, version: string, options?: StampOptions): number;
export declare function main(args?: readonly string[]): void;
