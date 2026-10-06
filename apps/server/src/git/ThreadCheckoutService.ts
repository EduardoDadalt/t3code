import {
  CheckpointRef,
  CommandId,
  GitMoveThreadToLocalCheckoutError,
  type GitCommandError,
  type GitMoveThreadToLocalCheckoutFailureReason,
  type GitMoveThreadToLocalCheckoutInput,
  type GitMoveThreadToLocalCheckoutResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";

export class ThreadCheckoutService extends Context.Service<
  ThreadCheckoutService,
  {
    /**
     * Moves a worktree thread back to its project's own checkout: the checkout
     * switches to the worktree's branch, receives the worktree's uncommitted
     * changes, the thread is re-pointed at it, and the worktree is removed.
     * Refuses a dirty checkout unless `localChanges` says how to clear it.
     */
    readonly moveToLocalCheckout: (
      input: GitMoveThreadToLocalCheckoutInput,
    ) => Effect.Effect<
      GitMoveThreadToLocalCheckoutResult,
      GitMoveThreadToLocalCheckoutError | GitCommandError
    >;
  }
>()("t3/git/ThreadCheckoutService") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;

  // Two concurrent moves of one thread would both pass the worktree check
  // and fight over the same branch switch.
  const movesInFlight = new Set<ThreadId>();

  const runGit = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    git
      .execute({ operation: `ThreadCheckoutService.${operation}`, cwd, args })
      .pipe(Effect.map((result) => result.stdout.trim()));

  const currentBranch = (cwd: string) =>
    git
      .execute({
        operation: "ThreadCheckoutService.currentBranch",
        cwd,
        args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
        allowNonZeroExit: true,
      })
      .pipe(
        Effect.map((result) =>
          result.exitCode === 0 && result.stdout.trim().length > 0 ? result.stdout.trim() : null,
        ),
      );

  const countChanges = (cwd: string) =>
    runGit("status", cwd, ["status", "--porcelain=v1"]).pipe(
      Effect.map((output) => output.split("\n").filter((line) => line.length > 0).length),
    );

  // Rollback steps run after the move already failed; their own failure is
  // logged so the original error still reaches the caller.
  const bestEffort = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    runGit(operation, cwd, args).pipe(Effect.ignoreCause({ log: true }));

  const performMove = Effect.fn("ThreadCheckoutService.performMove")(function* (
    input: GitMoveThreadToLocalCheckoutInput,
  ) {
    const fail = (
      reason: GitMoveThreadToLocalCheckoutFailureReason,
      extra?: { readonly changedFileCount?: number; readonly cause?: unknown },
    ) => new GitMoveThreadToLocalCheckoutError({ threadId: input.threadId, reason, ...extra });

    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["runs"])
      .pipe(Effect.mapError((cause) => fail("thread_unavailable", { cause })));
    const thread = records.thread;
    if (thread.deletedAt !== null) return yield* fail("thread_unavailable");
    const worktreePath = thread.worktreePath;
    if (worktreePath === null) return yield* fail("not_in_worktree");
    if (
      records.runs.some(
        (run) => run.status === "queued" || ThreadManagementService.isActiveRun(run),
      )
    ) {
      return yield* fail("thread_running");
    }

    const project = yield* projects.getById(thread.projectId).pipe(
      Effect.mapError((cause) => fail("project_unavailable", { cause })),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail("project_unavailable")),
          onSome: Effect.succeed,
        }),
      ),
    );
    const projectRoot = project.workspaceRoot;

    // Removing the worktree would pull it out from under any other thread.
    const projectThreads = yield* threadManagement
      .listProjectThreads({ projectId: thread.projectId, includeSubagents: false })
      .pipe(Effect.mapError((cause) => fail("thread_unavailable", { cause })));
    if (
      projectThreads.some(
        (other) => other.id !== thread.id && other.worktreePath?.trim() === worktreePath.trim(),
      )
    ) {
      return yield* fail("worktree_shared");
    }

    const worktreeBranch = yield* currentBranch(worktreePath);
    const worktreeHead = yield* runGit("worktreeHead", worktreePath, [
      "rev-parse",
      "--verify",
      "HEAD",
    ]);
    const changedFileCount = yield* countChanges(projectRoot);
    if (changedFileCount > 0 && input.localChanges === undefined) {
      return yield* fail("local_changes", { changedFileCount });
    }

    // Snapshot the worktree (tracked and untracked, minus ignored files) into
    // a hidden ref before anything changes, so a failure later can never lose
    // the work being moved.
    const snapshotRef = CheckpointRef.make(
      `refs/t3/local-checkout-moves/${Base64Url.encode(input.threadId)}`,
    );
    yield* checkpointStore
      .captureCheckpoint({ cwd: worktreePath, checkpointRef: snapshotRef })
      .pipe(Effect.mapError((cause) => fail("snapshot_failed", { cause })));
    const snapshotTree = yield* runGit("snapshotTree", worktreePath, [
      "rev-parse",
      "--verify",
      `${snapshotRef}^{tree}`,
    ]);
    const headTree = yield* runGit("headTree", worktreePath, [
      "rev-parse",
      "--verify",
      `${worktreeHead}^{tree}`,
    ]);
    const hasWorktreeChanges = snapshotTree !== headTree;

    if (changedFileCount > 0 && input.localChanges !== undefined) {
      switch (input.localChanges.type) {
        case "commit":
          yield* git.commit(projectRoot, input.localChanges.message, "", { stage: {} });
          break;
        case "stash":
          yield* runGit("stashLocalChanges", projectRoot, [
            "stash",
            "push",
            "--include-untracked",
            "--message",
            `T3 Code: set aside before moving "${thread.title}" here`,
          ]);
          break;
        case "discard":
          yield* runGit("discardLocalChanges", projectRoot, ["reset", "--hard", "--quiet", "HEAD"]);
          yield* runGit("cleanLocalChanges", projectRoot, ["clean", "-fd", "--quiet"]);
          break;
      }
      const remaining = yield* countChanges(projectRoot);
      if (remaining > 0) return yield* fail("local_changes", { changedFileCount: remaining });
    }

    const localBranch = yield* currentBranch(projectRoot);
    const localHead = yield* runGit("localHead", projectRoot, ["rev-parse", "--verify", "HEAD"]);
    const commandId = CommandId.make(
      `server:move-to-local-checkout:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`,
    );

    // Each step undoes the ones before it if anything after it fails.
    // `read-tree -m -u` refuses to overwrite files that differ from the tree
    // it expects, so neither direction can clobber edits made meanwhile.
    const repointThread = threadManagement
      .dispatch({
        type: "thread.metadata.update",
        commandId,
        threadId: input.threadId,
        branch: worktreeBranch,
        worktreePath: null,
        expectedWorktreePath: worktreePath,
      })
      .pipe(Effect.mapError((cause) => fail("thread_update_failed", { cause })));
    const applyChanges = hasWorktreeChanges
      ? runGit("applyChanges", projectRoot, ["read-tree", "-m", "-u", "HEAD", snapshotTree]).pipe(
          Effect.andThen(
            repointThread.pipe(
              Effect.onError(() =>
                bestEffort("revertChanges", projectRoot, [
                  "read-tree",
                  "-m",
                  "-u",
                  snapshotTree,
                  "HEAD",
                ]),
              ),
            ),
          ),
        )
      : repointThread;
    const switchLocal = runGit(
      "switchLocal",
      projectRoot,
      worktreeBranch === null
        ? ["switch", "--quiet", "--detach", worktreeHead]
        : ["switch", "--quiet", worktreeBranch],
    ).pipe(
      Effect.andThen(
        applyChanges.pipe(
          Effect.onError(() =>
            bestEffort(
              "restoreLocalRef",
              projectRoot,
              localBranch === null
                ? ["switch", "--quiet", "--detach", localHead]
                : ["switch", "--quiet", localBranch],
            ),
          ),
        ),
      ),
    );
    // Git checks a branch out in only one worktree at a time, so the worktree
    // lets go of it first. Its files stay until the worktree is removed.
    yield* worktreeBranch === null
      ? switchLocal
      : runGit("detachWorktree", worktreePath, ["switch", "--quiet", "--detach"]).pipe(
          Effect.andThen(
            switchLocal.pipe(
              Effect.onError(() =>
                bestEffort("restoreWorktreeBranch", worktreePath, [
                  "switch",
                  "--quiet",
                  worktreeBranch,
                ]),
              ),
            ),
          ),
        );

    // The moved changes land unstaged, as ordinary edits on the branch.
    if (hasWorktreeChanges) yield* bestEffort("unstageChanges", projectRoot, ["reset", "--quiet"]);

    const worktreeRemoved = yield* git
      .removeWorktree({ cwd: projectRoot, path: worktreePath, force: true })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "Moved thread to the local checkout, but could not remove its worktree",
            {
              threadId: input.threadId,
              worktreePath,
              cause,
            },
          ).pipe(Effect.as(false)),
        ),
      );
    yield* checkpointStore
      .deleteCheckpointRefs({ cwd: projectRoot, checkpointRefs: [snapshotRef] })
      .pipe(Effect.ignoreCause({ log: true }));
    yield* vcsStatusBroadcaster
      .refreshStatus(projectRoot)
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);

    return { branch: worktreeBranch, worktreePath, worktreeRemoved };
  });

  const moveToLocalCheckout: ThreadCheckoutService["Service"]["moveToLocalCheckout"] = (input) =>
    // Uninterruptible: a cancelled request must not stop between switching
    // branches and re-pointing the thread.
    Effect.uninterruptible(
      Effect.suspend(() => {
        if (movesInFlight.has(input.threadId)) {
          return Effect.fail(
            new GitMoveThreadToLocalCheckoutError({
              threadId: input.threadId,
              reason: "move_in_progress",
            }),
          );
        }
        movesInFlight.add(input.threadId);
        return performMove(input).pipe(
          Effect.ensuring(Effect.sync(() => movesInFlight.delete(input.threadId))),
        );
      }),
    );

  return ThreadCheckoutService.of({ moveToLocalCheckout });
});

export const layer = Layer.effect(ThreadCheckoutService, make);
