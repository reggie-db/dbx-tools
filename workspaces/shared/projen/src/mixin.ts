/**
 * Mixin factory for `constructs` {@link ConstructsMixin}.
 *
 * Apply with `project.with(...)` across the subtree. Package-targeting mixins
 * compose the `predicate.hasName` / `predicate.hasTag` / `predicate.inRelPath`
 * builders from `./project`.
 */
import type { predicate } from "@dbx-tools/shared-core";
import type { IConstruct, IMixin as ConstructsMixin } from "constructs";

export type { ConstructsMixin };

/**
 * Builds a {@link ConstructsMixin} from `supports` and `applyTo` callbacks.
 *
 * When `supports` is a type guard (`construct is U`) or a {@link predicate.Predicate},
 * `applyTo` receives the narrowed `U`.
 */
export function mixin<U extends IConstruct>(
  supports: predicate.Predicate<IConstruct, U>,
  applyTo: (construct: U) => void,
): ConstructsMixin;

export function mixin<U extends IConstruct>(
  supports: (construct: IConstruct) => construct is U,
  applyTo: (construct: U) => void,
): ConstructsMixin;

export function mixin(
  supports: (construct: IConstruct) => boolean,
  applyTo: (construct: IConstruct) => void,
): ConstructsMixin;

export function mixin(
  supports: (construct: IConstruct) => boolean,
  applyTo: (construct: IConstruct) => void,
): ConstructsMixin {
  return {
    supports,
    applyTo: (construct: IConstruct): void => {
      if (supports(construct)) {
        (applyTo as (construct: IConstruct) => void)(construct);
      }
    },
  };
}
