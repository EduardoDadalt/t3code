// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
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

const threadId = ThreadId.make("thread-move-to-local");
const projectId = ProjectId.make("project-move-to-local");

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerInfrastructure = Layer.mergeAll(
  GitVcsDriver.layer,
  CheckpointStore.layer.pipe(
    Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
  ),
).pipe(
  Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-move-local-" })),
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
 * A project checkout on `main` and a worktree on `feature` holding one commit
 * plus uncommitted edits: a modification, a deletion, and a new file.
 */
const setupRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const tmp = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-move-local-" });
  const projectRoot = NodePath.join(tmp, "project");
  const worktreePath = NodePath.join(tmp, "worktree");
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
  return { projectRoot, worktreePath };
});

const serviceLayer = (input: {
  readonly projectRoot: string;
  readonly worktreePath: string;
  readonly dispatched: Array<OrchestrationV2ServerCommand>;
  readonly failDispatch?: boolean;
}) => {
  const thread = {
    id: threadId,
    projectId,
    title: "Move me",
    branch: "feature",
    worktreePath: input.worktreePath,
    deletedAt: null,
  };
  return ThreadCheckoutService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () =>
            Effect.succeed({ thread, runs: [] } as unknown as OrchestrationV2ThreadProjection),
          listProjectThreads: () =>
            Effect.succeed([thread as unknown as OrchestrationV2ThreadShell]),
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

it.layer(layerInfrastructure)("ThreadCheckoutService", (it) => {
  describe("moveToLocalCheckout", () => {
    it.effect("moves the branch and uncommitted changes into the project checkout", () =>
      Effect.gen(function* () {
        const { projectRoot, worktreePath } = yield* setupRepository;
        const dispatched: Array<OrchestrationV2ServerCommand> = [];

        const result = yield* Effect.gen(function* () {
          const service = yield* ThreadCheckoutService.ThreadCheckoutService;
          return yield* service.moveToLocalCheckout({ threadId });
        }).pipe(Effect.provide(serviceLayer({ projectRoot, worktreePath, dispatched })));

        expect(result).toEqual({ branch: "feature", worktreePath, worktreeRemoved: true });
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
        expect(yield* git(projectRoot, ["for-each-ref", "refs/t3/local-checkout-moves"])).toBe("");
      }),
    );

    it.effect("refuses a dirty project checkout without touching either side", () =>
      Effect.gen(function* () {
        const { projectRoot, worktreePath } = yield* setupRepository;
        yield* write(NodePath.join(projectRoot, "README.md"), "# local edit\n");
        const dispatched: Array<OrchestrationV2ServerCommand> = [];

        const error = yield* Effect.gen(function* () {
          const service = yield* ThreadCheckoutService.ThreadCheckoutService;
          return yield* service.moveToLocalCheckout({ threadId });
        }).pipe(
          Effect.provide(serviceLayer({ projectRoot, worktreePath, dispatched })),
          Effect.flip,
        );

        expect(error).toMatchObject({ reason: "local_changes", changedFileCount: 1 });
        expect(yield* git(projectRoot, ["branch", "--show-current"])).toBe("main");
        expect(yield* read(NodePath.join(projectRoot, "README.md"))).toBe("# local edit\n");
        expect(yield* git(worktreePath, ["branch", "--show-current"])).toBe("feature");
        expect(yield* read(NodePath.join(worktreePath, "new.txt"))).toBe("brand new\n");
        expect(dispatched).toEqual([]);
      }),
    );

    it.effect("stashes local changes when asked, then moves", () =>
      Effect.gen(function* () {
        const { projectRoot, worktreePath } = yield* setupRepository;
        yield* write(NodePath.join(projectRoot, "local.txt"), "keep me\n");
        const dispatched: Array<OrchestrationV2ServerCommand> = [];

        yield* Effect.gen(function* () {
          const service = yield* ThreadCheckoutService.ThreadCheckoutService;
          return yield* service.moveToLocalCheckout({
            threadId,
            localChanges: { type: "stash" },
          });
        }).pipe(Effect.provide(serviceLayer({ projectRoot, worktreePath, dispatched })));

        expect(yield* git(projectRoot, ["branch", "--show-current"])).toBe("feature");
        expect(yield* exists(NodePath.join(projectRoot, "local.txt"))).toBe(false);
        expect(yield* git(projectRoot, ["stash", "list", "--format=%s"])).toContain(
          'T3 Code: set aside before moving "Move me" here',
        );
        expect(dispatched).toHaveLength(1);
      }),
    );

    it.effect("rolls everything back when the thread cannot be re-pointed", () =>
      Effect.gen(function* () {
        const { projectRoot, worktreePath } = yield* setupRepository;
        const dispatched: Array<OrchestrationV2ServerCommand> = [];

        const error = yield* Effect.gen(function* () {
          const service = yield* ThreadCheckoutService.ThreadCheckoutService;
          return yield* service.moveToLocalCheckout({ threadId });
        }).pipe(
          Effect.provide(
            serviceLayer({ projectRoot, worktreePath, dispatched, failDispatch: true }),
          ),
          Effect.flip,
        );

        expect(error).toMatchObject({ reason: "thread_update_failed" });
        expect(yield* git(projectRoot, ["branch", "--show-current"])).toBe("main");
        expect(yield* git(projectRoot, ["status", "--porcelain=v1"])).toBe("");
        expect(yield* git(worktreePath, ["branch", "--show-current"])).toBe("feature");
        expect(yield* git(worktreePath, ["status", "--porcelain=v1"])).toBe(
          [" M README.md", " D obsolete.txt", "?? new.txt"].join("\n"),
        );
      }),
    );
  });
});
