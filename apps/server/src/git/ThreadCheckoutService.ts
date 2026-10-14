import {
  CheckpointRef,
  CommandId,
  GitMoveThreadToWorktreeError,
  type GitCommandError,
  type GitListThreadMoveTargetsInput,
  type GitListThreadMoveTargetsResult,
  type GitMoveThreadToWorktreeFailureReason,
  type GitMoveThreadToWorktreeInput,
  type GitMoveThreadToWorktreeResult,
  type GitThreadMoveTarget,
  type ThreadId,
} from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";

/** Paths of a dirty target carried on the error; its message names fewer. */
const REPORTED_CHANGED_FILES = 20;

export class ThreadCheckoutService extends Context.Service<
  ThreadCheckoutService,
  {
    /** Worktrees of the thread's project it could move to: every one but its own. */
    readonly listMoveTargets: (
      input: GitListThreadMoveTargetsInput,
    ) => Effect.Effect<
      GitListThreadMoveTargetsResult,
      GitMoveThreadToWorktreeError | GitCommandError
    >;
    /**
     * Moves a worktree thread into another worktree of its project, the
     * project's own checkout included: the target switches to the thread's
     * branch, receives the worktree's uncommitted changes, and the thread is
     * re-pointed at it. The worktree it leaves is removed or kept detached and
     * clean. Refuses a dirty target unless `targetChanges` says how to clear it.
     */
    readonly moveToWorktree: (
      input: GitMoveThreadToWorktreeInput,
    ) => Effect.Effect<
      GitMoveThreadToWorktreeResult,
      GitMoveThreadToWorktreeError | GitCommandError
    >;
  }
>()("t3/git/ThreadCheckoutService") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
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

  // Not trimmed: each line starts with a two-column status that may be blank.
  const changedFiles = (cwd: string) =>
    git
      .execute({
        operation: "ThreadCheckoutService.status",
        cwd,
        args: ["status", "--porcelain=v1"],
      })
      .pipe(
        Effect.map((result) =>
          result.stdout
            .split("\n")
            .filter((line) => line.length > 3)
            .map((line) => line.slice(3)),
        ),
      );

  // Thread and project paths are stored as given; Git reports resolved ones.
  const realPath = (path: string) =>
    fileSystem.realPath(path).pipe(Effect.orElseSucceed(() => path));

  // Rollback steps run after the move already failed; their own failure is
  // logged so the original error still reaches the caller.
  const bestEffort = (operation: string, cwd: string, args: ReadonlyArray<string>) =>
    runGit(operation, cwd, args).pipe(Effect.ignoreCause({ log: true }));

  const failure =
    (threadId: ThreadId) =>
    (
      reason: GitMoveThreadToWorktreeFailureReason,
      extra?: {
        readonly changedFileCount?: number;
        readonly changedFiles?: ReadonlyArray<string>;
        readonly cause?: unknown;
      },
    ) =>
      new GitMoveThreadToWorktreeError({ threadId, reason, ...extra });

  /** The thread, its project, and the worktree it works in. */
  const resolveSource = Effect.fn("ThreadCheckoutService.resolveSource")(function* (
    threadId: ThreadId,
  ) {
    const fail = failure(threadId);
    const records = yield* threadManagement
      .getThreadRecords(threadId, ["runs", "providerThreads", "turnItems"], {
        turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
        turnItemStatuses: ["pending", "running", "waiting"],
      })
      .pipe(Effect.mapError((cause) => fail("thread_unavailable", { cause })));
    const thread = records.thread;
    if (thread.deletedAt !== null) return yield* fail("thread_unavailable");
    const sourcePath = thread.worktreePath;
    if (sourcePath === null) return yield* fail("not_in_worktree");
    const project = yield* projects.getById(thread.projectId).pipe(
      Effect.mapError((cause) => fail("project_unavailable", { cause })),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(fail("project_unavailable")),
          onSome: Effect.succeed,
        }),
      ),
    );
    return { records, thread, sourcePath, projectRoot: project.workspaceRoot };
  });

  const listTargets = Effect.fn("ThreadCheckoutService.listTargets")(function* (input: {
    readonly projectRoot: string;
    readonly sourcePath: string;
  }) {
    const [realProjectRoot, realSource] = yield* Effect.all([
      realPath(input.projectRoot),
      realPath(input.sourcePath),
    ]);
    const paths = yield* git.listWorktreePaths(input.projectRoot);
    const targets = yield* Effect.forEach(paths, (path) =>
      Effect.gen(function* () {
        const real = yield* realPath(path);
        if (real === realSource) return [];
        const isProjectRoot = real === realProjectRoot;
        const target: GitThreadMoveTarget = {
          // The project's own checkout keeps the path the thread will be bound to.
          path: isProjectRoot ? input.projectRoot : path,
          branch: yield* currentBranch(path),
          isProjectRoot,
        };
        return [{ target, real }];
      }),
    );
    return targets
      .flat()
      .toSorted(
        (left, right) =>
          Number(right.target.isProjectRoot) - Number(left.target.isProjectRoot) ||
          left.target.path.localeCompare(right.target.path),
      );
  });

  const listMoveTargets: ThreadCheckoutService["Service"]["listMoveTargets"] = Effect.fn(
    "ThreadCheckoutService.listMoveTargets",
  )(function* (input) {
    const source = yield* resolveSource(input.threadId);
    const targets = yield* listTargets(source);
    return { targets: targets.map(({ target }) => target) };
  });

  const performMove = Effect.fn("ThreadCheckoutService.performMove")(function* (
    input: GitMoveThreadToWorktreeInput,
  ) {
    const fail = failure(input.threadId);
    const { records, thread, sourcePath, projectRoot } = yield* resolveSource(input.threadId);
    if (
      records.runs.some(
        (run) => run.status === "queued" || ThreadManagementService.isActiveRun(run),
      )
    ) {
      return yield* fail("thread_running");
    }
    // Re-pointing the thread detaches its provider session, which ends the
    // background agents and commands still running inside it (#16000).
    if (
      derivePendingBackgroundWork({
        latestRun: records.runs.findLast((run) => run.status !== "queued"),
        providerThreads: records.providerThreads,
        turnItems: records.turnItems,
        activeProviderThreadId: thread.activeProviderThreadId,
        runs: records.runs,
      }).length > 0
    ) {
      return yield* fail("background_work");
    }

    const realTarget = yield* realPath(input.targetPath);
    const target = (yield* listTargets({ projectRoot, sourcePath })).find(
      (candidate) => candidate.real === realTarget,
    )?.target;
    if (target === undefined) return yield* fail("target_unavailable");
    const targetPath = target.path;

    const projectThreads = yield* threadManagement
      .listProjectThreads({ projectId: thread.projectId, includeSubagents: false })
      .pipe(Effect.mapError((cause) => fail("thread_unavailable", { cause })));
    // Moving changes and the branch out of the worktree would pull them out
    // from under any other thread working there.
    if (
      projectThreads.some(
        (other) => other.id !== thread.id && other.worktreePath?.trim() === sourcePath.trim(),
      )
    ) {
      return yield* fail("worktree_shared");
    }
    // Switching the target's branch under a running turn would rewrite the
    // files that turn is editing.
    const runningCheckouts = yield* Effect.forEach(
      projectThreads.filter((other) => other.activeRunId !== null),
      (other) => realPath(other.worktreePath ?? projectRoot),
    );
    if (runningCheckouts.includes(realTarget)) return yield* fail("target_busy");

    const sourceBranch = yield* currentBranch(sourcePath);
    const sourceHead = yield* runGit("sourceHead", sourcePath, ["rev-parse", "--verify", "HEAD"]);
    const targetChanges = yield* changedFiles(targetPath);
    if (targetChanges.length > 0 && input.targetChanges === undefined) {
      return yield* fail("target_changes", {
        changedFileCount: targetChanges.length,
        changedFiles: targetChanges.slice(0, REPORTED_CHANGED_FILES),
      });
    }

    // Snapshot the worktree (tracked and untracked, minus ignored files) into
    // a hidden ref before anything changes, so a failure later can never lose
    // the work being moved.
    const snapshotRef = CheckpointRef.make(
      `refs/t3/worktree-moves/${Base64Url.encode(input.threadId)}`,
    );
    yield* checkpointStore
      .captureCheckpoint({ cwd: sourcePath, checkpointRef: snapshotRef })
      .pipe(Effect.mapError((cause) => fail("snapshot_failed", { cause })));
    const snapshotTree = yield* runGit("snapshotTree", sourcePath, [
      "rev-parse",
      "--verify",
      `${snapshotRef}^{tree}`,
    ]);
    const headTree = yield* runGit("headTree", sourcePath, [
      "rev-parse",
      "--verify",
      `${sourceHead}^{tree}`,
    ]);
    const hasSourceChanges = snapshotTree !== headTree;

    if (targetChanges.length > 0 && input.targetChanges !== undefined) {
      switch (input.targetChanges.type) {
        case "commit":
          yield* git.commit(targetPath, input.targetChanges.message, "", { stage: {} });
          break;
        case "stash":
          yield* runGit("stashTargetChanges", targetPath, [
            "stash",
            "push",
            "--include-untracked",
            "--message",
            `T3 Code: set aside before moving "${thread.title}" here`,
          ]);
          break;
        case "discard":
          yield* runGit("discardTargetChanges", targetPath, ["reset", "--hard", "--quiet", "HEAD"]);
          yield* runGit("cleanTargetChanges", targetPath, ["clean", "-fd", "--quiet"]);
          break;
      }
      const remaining = yield* changedFiles(targetPath);
      if (remaining.length > 0) {
        return yield* fail("target_changes", {
          changedFileCount: remaining.length,
          changedFiles: remaining.slice(0, REPORTED_CHANGED_FILES),
        });
      }
    }

    const previousBranch = yield* currentBranch(targetPath);
    const targetHead = yield* runGit("targetHead", targetPath, ["rev-parse", "--verify", "HEAD"]);
    const commandId = CommandId.make(
      `server:move-to-worktree:${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}`,
    );

    // Each step undoes the ones before it if anything after it fails.
    // `read-tree -m -u` refuses to overwrite files that differ from the tree
    // it expects, so neither direction can clobber edits made meanwhile.
    const repointThread = threadManagement
      .dispatch({
        type: "thread.metadata.update",
        commandId,
        threadId: input.threadId,
        branch: sourceBranch,
        worktreePath: target.isProjectRoot ? null : targetPath,
        expectedWorktreePath: sourcePath,
      })
      .pipe(Effect.mapError((cause) => fail("thread_update_failed", { cause })));
    const applyChanges = hasSourceChanges
      ? runGit("applyChanges", targetPath, ["read-tree", "-m", "-u", "HEAD", snapshotTree]).pipe(
          Effect.andThen(
            repointThread.pipe(
              Effect.onError(() =>
                bestEffort("revertChanges", targetPath, [
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
    const switchTarget = runGit(
      "switchTarget",
      targetPath,
      sourceBranch === null
        ? ["switch", "--quiet", "--detach", sourceHead]
        : ["switch", "--quiet", sourceBranch],
    ).pipe(
      Effect.andThen(
        applyChanges.pipe(
          Effect.onError(() =>
            bestEffort(
              "restoreTargetRef",
              targetPath,
              previousBranch === null
                ? ["switch", "--quiet", "--detach", targetHead]
                : ["switch", "--quiet", previousBranch],
            ),
          ),
        ),
      ),
    );
    // Git checks a branch out in only one worktree at a time, so the source
    // lets go of it first. Its files stay until it is cleaned or removed.
    yield* sourceBranch === null
      ? switchTarget
      : runGit("detachSource", sourcePath, ["switch", "--quiet", "--detach"]).pipe(
          Effect.andThen(
            switchTarget.pipe(
              Effect.onError(() =>
                bestEffort("restoreSourceBranch", sourcePath, ["switch", "--quiet", sourceBranch]),
              ),
            ),
          ),
        );

    // The moved changes land unstaged, as ordinary edits on the branch.
    if (hasSourceChanges) yield* bestEffort("unstageChanges", targetPath, ["reset", "--quiet"]);

    const sourceWorktreeRemoved = input.removeSourceWorktree
      ? yield* git.removeWorktree({ cwd: projectRoot, path: sourcePath, force: true }).pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("Moved thread, but could not remove the worktree it left", {
              threadId: input.threadId,
              sourcePath,
              cause,
            }).pipe(Effect.as(false)),
          ),
        )
      : false;
    // A kept worktree gives up the changes that moved, as `git stash` would.
    // Ignored files were not moved and stay.
    if (!input.removeSourceWorktree && hasSourceChanges) {
      yield* bestEffort("resetSource", sourcePath, ["reset", "--hard", "--quiet", "HEAD"]);
      yield* bestEffort("cleanSource", sourcePath, ["clean", "-fd", "--quiet"]);
    }
    yield* checkpointStore
      .deleteCheckpointRefs({ cwd: projectRoot, checkpointRefs: [snapshotRef] })
      .pipe(Effect.ignoreCause({ log: true }));
    yield* Effect.forEach(
      sourceWorktreeRemoved ? [targetPath] : [targetPath, sourcePath],
      (cwd) => vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true })),
      { discard: true },
    ).pipe(Effect.forkDetach);

    return {
      branch: sourceBranch,
      previousBranch,
      sourceWorktreePath: sourcePath,
      sourceWorktreeRemoved,
    };
  });

  const moveToWorktree: ThreadCheckoutService["Service"]["moveToWorktree"] = (input) =>
    // Uninterruptible: a cancelled request must not stop between switching
    // branches and re-pointing the thread.
    Effect.uninterruptible(
      Effect.suspend(() => {
        if (movesInFlight.has(input.threadId)) {
          return Effect.fail(failure(input.threadId)("move_in_progress"));
        }
        movesInFlight.add(input.threadId);
        return performMove(input).pipe(
          Effect.ensuring(Effect.sync(() => movesInFlight.delete(input.threadId))),
        );
      }),
    );

  return ThreadCheckoutService.of({ listMoveTargets, moveToWorktree });
});

export const layer = Layer.effect(ThreadCheckoutService, make);
