import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { vcsCommandConcurrency, vcsCommandScheduler } from "./vcsCommandScheduler.ts";

export function createGitEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    pullRequestResolution: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:git:resolve-pull-request",
      tag: WS_METHODS.gitResolvePullRequest,
    }),
    preparePullRequestThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:prepare-pull-request-thread",
      tag: WS_METHODS.gitPreparePullRequestThread,
      scheduler: vcsCommandScheduler,
      concurrency: vcsCommandConcurrency,
    }),
    // The server serializes moves per thread; the input carries no cwd to schedule on.
    moveThreadToLocalCheckout: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:git:move-thread-to-local-checkout",
      tag: WS_METHODS.gitMoveThreadToLocalCheckout,
    }),
  };
}
