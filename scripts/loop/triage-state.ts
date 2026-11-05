/**
 * Canonical triage state resolution delegates to the unified Project Workspace module
 * in @animus/contracts/paths.
 */
export {
  resolveCanonicalGitCommon,
  isStateRootOutsideCheckout,
  computeGitCommonHash,
  resolveTriageStateRoot,
} from "../../packages/contracts/src/paths";
