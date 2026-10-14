// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  type GitMoveThreadToWorktreeInput,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ThreadCheckoutService from "./ThreadCheckoutService.ts";

const threadId = ThreadId.make("thread-move-to-worktree");
const projectId = ProjectId.make("project-move-to-worktree");

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerInfrastructure = Layer.mergeAll(
  GitVcsDriver.layer,
  CheckpointStore.layer.pipe(
    Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
  ),
).pipe(
  Layer.provide(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-move-worktree-" }),
  ),
  Layer.provideMerge(layerVcsProcess),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({ operation: "test.git", cwd, args, timeoutMs: 10_000 });
    return result.stdout.trimEnd();
  });

const write = (path: string, contents: string) =>
  Effect.gen(function* () {
    yield* (yield* FileSystem.FileSystem).writeFileString(path, contents);
  });

const read = (path: string) =>
  Effect.gen(function* () {
    return yield* (yield* FileSystem.FileSystem).readFileString(path);
  });

const exists = (path: string) =>
  Effect.gen(function* () {
    return yield* (yield* FileSystem.FileSystem).exists(path);
  });

/**
 * A project checkout on `main`, a worktree on `feature` holding one commit
 * plus uncommitted edits (a modification, a deletion, and a new file), and a
 * second worktree on `docker`.
 */
const setupRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const tmp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-move-worktree-" });
  const projectRoot = NodePath.join(tmp, "project");
  const worktreePath = NodePath.join(tmp, "worktree");
  const otherWorktreePath = NodePath.join(tmp, "other");
  yield* fileSystem.makeDirectory(projectRoot);
  yield* git(projectRoot, ["init", "--quiet", "--initial-branch=main"]);
  yield* git(projectRoot, ["config", "user.email", "test@test.com"]);
  yield* git(projectRoot, ["config", "user.name", "Test"]);
  yield* write(NodePath.join(projectRoot, "README.md"), "# project\n");
  yield* write(NodePath.join(projectRoot, "obsolete.txt"), "old\n");
  yield* git(projectRoot, ["add", "."]);
  yield* git(projectRoot, ["commit", "--quiet", "-m", "initial"]);
  yield* git(projectRoot, ["worktree", "add", "--quiet", "-b", "feature", worktreePath]);
  yield* write(NodePath.join(worktreePath, "committed.txt"), "on the branch\n");
  yield* git(worktreePath, ["add", "."]);
  yield* git(worktreePath, ["commit", "--quiet", "-m", "feature work"]);
  yield* write(NodePath.join(worktreePath, "README.md"), "# project\nedited in worktree\n");
  yield* write(NodePath.join(worktreePath, "new.txt"), "brand new\n");
  yield* fileSystem.remove(NodePath.join(worktreePath, "obsolete.txt"));
  yield* git(projectRoot, ["worktree", "add", "--quiet", "-b", "docker", otherWorktreePath]);
  // Paths as Git reports them, so comparisons survive a symlinked temp dir.
  const real = (path: string) => fileSystem.realPath(path);
  return {
    projectRoot,
    worktreePath: yield* real(worktreePath),
    otherWorktreePath: yield* real(otherWorktreePath),
  };
});

const serviceLayer = (input: {
  readonly projectRoot: string;
  readonly worktreePath: string;
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
  readonly failDispatch?: boolean;
  readonly runs?: ReadonlyArray<unknown>;
  readonly turnItems?: ReadonlyArray<unknown>;
  readonly otherThreads?: ReadonlyArray<Partial<OrchestrationV2ThreadShell>>;
}) => {
  const thread = {
    id: threadId,
    projectId,
    title: "Move me",
    branch: "feature",
    worktreePath: input.worktreePath,
    activeProviderThreadId: null,
    activeRunId: null,
    deletedAt: null,
  };
  return ThreadCheckoutService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({
              thread,
              runs: input.runs ?? [],
              providerThreads: [],
              turnItems: input.turnItems ?? [],
            } as unknown as OrchestrationV2ThreadProjection),
          listProjectThreads: () =>
            Effect.succeed([
              thread,
              ...(input.otherThreads ?? []),
            ] as unknown as Array<OrchestrationV2ThreadShell>),
          dispatch: (command) => {
            if (input.failDispatch === true) {
              return Effect.fail(
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "worktree changed",
                }),
              );
            }
            input.dispatched.push(command);
            return Effect.succeed({ sequence: 1, storedEvents: [] });
          },
        } satisfies Partial<ThreadManagementService.ThreadManagementService["Service"]>),
        Layer.mock(ProjectService.ProjectService)({
          getById: () =>
            Effect.succeed(
              Option.some({ id: projectId, workspaceRoot: input.projectRoot } as Project),
            ),
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshStatus: () => Effect.never,
        }),
      ),
    ),
  );
};

const moveToWorktree = (input: Omit<GitMoveThreadToWorktreeInput, "threadId">) =>
  Effect.gen(function* () {
    const service = yield* ThreadCheckoutService.ThreadCheckoutService;
    return yield* service.moveToWorktree({ threadId, ...input });
  });

it.layer(layerInfrastructure)("ThreadCheckoutService", (it) => {
  describe("listMoveTargets", () => {
    it.effect(
      "lists the project's other worktrees, detached ones included, its own checkout first",
      () =>
        Effect.gen(function* () {
          const { projectRoot, worktreePath, otherWorktreePath } = yield* setupRepository;
          const detachedPath = NodePath.join(NodePath.dirname(otherWorktreePath), "detached");
          yield* git(projectRoot, ["worktree", "add", "--quiet", "--detach", detachedPath]);

          const result = yield* Effect.gen(function* () {
            const service = yield* ThreadCheckoutService.ThreadCheckoutService;
            return yield* service.listMoveTargets({ threadId });
          }).pipe(Effect.provide(serviceLayer({ projectRoot, worktreePath, dispatched: [] })));

          expect(result.targets).toEqual([
            { path: projectRoot, branch: "main", isProjectRoot: true },
            { path: detachedPath, branch: null, isProjectRoot: false },
            { path: otherWorktreePath, branch: "docker", isProjectRoot: false },
          ]);
        }),
    );
  });

  describe("moveToWorktree", () => {
    it.effect("moves the branch and uncommitted changes into the project checkout", () =>
      Effect.gen(function* () {
        const { projectRoot, worktreePath } = yield* setupRepository;
        const dispatched: Array<OrchestrationV2ServerCommand> = [];

        const result = yield* moveToWorktree({
          targetPath: projectRoot,
          removeSourceWorktree: true,
        }).pipe(Effect.provide(serviceLayer({ projectRoot, worktreePath, dispatched })));

        expect(result).toEqual({
          branch: "feature",
          previousBranch: "main",
          sourceWorktreePath: worktreePath,
          sourceWorktreeRemoved: true,
        });
        expect(yield* git(projectRoot, ["branch", "--show-current"])).toBe("feature");
        expect(yield* read(NodePath.join(projectRoot, "committed.txt"))).toBe("on the branch\n");
        expect(yield* read(NodePath.join(projectRoot, "README.md"))).toBe(
          "# project\nedited in worktree\n",
        );
        expect(yield* read(NodePath.join(projectRoot, "new.txt"))).toBe("brand new\n");
        expect(yield* exists(NodePath.join(projectRoot, "obsolete.txt"))).toBe(false);
        // The changes arrive as ordinary unstaged edits.
        expect(yield* git(projectRoot, ["status", "--porcelain=v1"])).toBe(
          [" M README.md", " D obsolete.txt", "?? new.txt"].join("\n"),
        );
        expect(yield* exists(worktreePath)).toBe(false);
        expect(dispatched).toMatchObject([
          {
            type: "thread.metadata.update",
            threadId,
            branch: "feature",
            worktreePath: null,
            expectedWorktreePath: worktreePath,
          },
        ]);
        expect(yield* git(projectRoot, ["for-each-ref", "refs/t3/worktree-moves"])).toBe("");
      }),
    );

    it.effect("moves into another worktree and keeps the source detached and clean", () =>
      Effect.gen(function* () {
        const { projectRoot, worktreePath, otherWorktreePath } = yield* setupRepository;
        const dispatched: Array<OrchestrationV2ServerCommand> = [];

        const result = yield* moveToWorktree({
          targetPath: otherWorktreePath,
          removeSourceWorktree: false,
        }).pipe(Effect.provide(serviceLayer({ projectRoot, worktreePath, dispatched })));

        expect(result).toEqual({
          branch: "feature",
          previousBranch: "docker",
          sourceWorktreePath: worktreePath,
          sourceWorktreeRemoved: false,
        });
        expect(yield* git(otherWorktreePath, ["branch", "--show-current"])).toBe("feature");
        expect(yield* git(otherWorktreePath, ["status", "--porcelain=v1"])).toBe(
          [" M README.md", " D obsolete.txt", "?? new.txt"].join("\n"),
        );
        expect(yield* git(worktreePath, ["branch", "--show-current"])).toBe("");
        expect(yield* git(worktreePath, ["status", "--porcelain=v1"])).toBe("");
        expect(yield* git(projectRoot, ["branch", "--show-current"])).toBe("main");
        expect(dispatched).toMatchObject([
          { type: "thread.metadata.update", branch: "feature", worktreePath: otherWorktreePath },
        ]);
      }),
    );

    it.effect(
      "refuses a dirty target, naming its changed files, without touching either side",
      () =>
        Effect.gen(function* () {
          const { projectRoot, worktreePath } = yield* setupRepository;
          yield* write(NodePath.join(projectRoot, "README.md"), "# local edit\n");
          const dispatched: Array<OrchestrationV2ServerCommand> = [];

          const error = yield* moveToWorktree({
            targetPath: projectRoot,
            removeSourceWorktree: true,
          }).pipe(
            Effect.provide(serviceLayer({ projectRoot, worktreePath, dispatched })),
            Effect.flip,
          );

          expect(error).toMatchObject({
            reason: "target_changes",
            changedFileCount: 1,
            changedFiles: ["README.md"],
          });
          expect(error.message).toContain("README.md");
          expect(yield* git(projectRoot, ["branch", "--show-current"])).toBe("main");
          expect(yield* read(NodePath.join(projectRoot, "README.md"))).toBe("# local edit\n");
          expect(yield* git(worktreePath, ["branch", "--show-current"])).toBe("feature");
          expect(yield* read(NodePath.join(worktreePath, "new.txt"))).toBe("brand new\n");
          expect(dispatched).toEqual([]);
        }),
    );

    it.effect("stashes the target's changes when asked, then moves", () =>
      Effect.gen(function* () {
        const { projectRoot, worktreePath } = yield* setupRepository;
        yield* write(NodePath.join(projectRoot, "local.txt"), "keep me\n");
        const dispatched: Array<OrchestrationV2ServerCommand> = [];

        yield* moveToWorktree({
          targetPath: projectRoot,
          targetChanges: { type: "stash" },
          removeSourceWorktree: true,
        }).pipe(Effect.provide(serviceLayer({ projectRoot, worktreePath, dispatched })));

        expect(yield* git(projectRoot, ["branch", "--show-current"])).toBe("feature");
        expect(yield* exists(NodePath.join(projectRoot, "local.txt"))).toBe(false);
        expect(yield* git(projectRoot, ["stash", "list", "--format=%s"])).toContain(
          'T3 Code: set aside before moving "Move me" here',
        );
        expect(dispatched).toHaveLength(1);
      }),
    );

    it.effect("refuses while background agents or commands still run in the thread", () =>
      Effect.gen(function* () {
        const { projectRoot, worktreePath } = yield* setupRepository;
        const dispatched: Array<OrchestrationV2ServerCommand> = [];

        const error = yield* moveToWorktree({
          targetPath: projectRoot,
          removeSourceWorktree: true,
        }).pipe(
          Effect.provide(
            serviceLayer({
              projectRoot,
              worktreePath,
              dispatched,
              runs: [{ id: "run-1", ordinal: 1, status: "completed" }],
              turnItems: [
                {
                  id: "item-1",
                  type: "subagent",
                  status: "running",
                  title: "Explore",
                  runId: "run-1",
                },
              ],
            }),
          ),
          Effect.flip,
        );

        expect(error).toMatchObject({ reason: "background_work" });
        expect(yield* git(worktreePath, ["branch", "--show-current"])).toBe("feature");
        expect(dispatched).toEqual([]);
      }),
    );

    it.effect("refuses a target another thread is running in", () =>
      Effect.gen(function* () {
        const { projectRoot, worktreePath, otherWorktreePath } = yield* setupRepository;
        const dispatched: Array<OrchestrationV2ServerCommand> = [];

        const error = yield* moveToWorktree({
          targetPath: otherWorktreePath,
          removeSourceWorktree: false,
        }).pipe(
          Effect.provide(
            serviceLayer({
              projectRoot,
              worktreePath,
              dispatched,
              otherThreads: [
                {
                  id: ThreadId.make("thread-in-target"),
                  worktreePath: otherWorktreePath,
                  activeRunId: RunId.make("run-in-target"),
                },
              ],
            }),
          ),
          Effect.flip,
        );

        expect(error).toMatchObject({ reason: "target_busy" });
        expect(yield* git(otherWorktreePath, ["branch", "--show-current"])).toBe("docker");
        expect(dispatched).toEqual([]);
      }),
    );

    it.effect("refuses a target that is not one of the project's worktrees", () =>
      Effect.gen(function* () {
        const { projectRoot, worktreePath } = yield* setupRepository;

        const error = yield* moveToWorktree({
          targetPath: worktreePath,
          removeSourceWorktree: false,
        }).pipe(
          Effect.provide(serviceLayer({ projectRoot, worktreePath, dispatched: [] })),
          Effect.flip,
        );

        expect(error).toMatchObject({ reason: "target_unavailable" });
      }),
    );

    it.effect("rolls everything back when the thread cannot be re-pointed", () =>
      Effect.gen(function* () {
        const { projectRoot, worktreePath, otherWorktreePath } = yield* setupRepository;
        const dispatched: Array<OrchestrationV2ServerCommand> = [];

        const error = yield* moveToWorktree({
          targetPath: otherWorktreePath,
          removeSourceWorktree: true,
        }).pipe(
          Effect.provide(
            serviceLayer({ projectRoot, worktreePath, dispatched, failDispatch: true }),
          ),
          Effect.flip,
        );

        expect(error).toMatchObject({ reason: "thread_update_failed" });
        expect(yield* git(otherWorktreePath, ["branch", "--show-current"])).toBe("docker");
        expect(yield* git(otherWorktreePath, ["status", "--porcelain=v1"])).toBe("");
        expect(yield* git(worktreePath, ["branch", "--show-current"])).toBe("feature");
        expect(yield* git(worktreePath, ["status", "--porcelain=v1"])).toBe(
          [" M README.md", " D obsolete.txt", "?? new.txt"].join("\n"),
        );
      }),
    );
  });
});
