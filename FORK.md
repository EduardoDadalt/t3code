# Fork differences

This repository is a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code)
(`upstream` remote). It tracks upstream stable releases and carries the few
changes below. Everything not listed here behaves exactly like upstream.

- Current upstream base: stable tag `v0.1.8`, merged into `main`.
- To see the full fork delta: `git diff v0.1.8 -- . ':!FORK.md'` (or
  `git log --no-merges <upstream-tag>..main`).
- Keep this file current when a fork-only change is added, removed, or upstreamed.

## 1. Move a worktree thread into another worktree

Upstream has no way to move a thread out of its worktree. The fork adds a
**Move to worktree…** thread action (sidebar context menu and the chat header
thread menu) on web and desktop. It moves the thread's branch, its uncommitted
changes, and the thread binding into the project's own checkout or any other
worktree of the project (detached ones included). Proposed upstream in
[discussion #16570](https://github.com/pingdotgg/t3code/discussions/16570).

Behavior that is easy to get wrong:

- The worktree is snapshotted to a hidden ref (`refs/t3/worktree-moves/<threadId>`)
  through `CheckpointStore.captureCheckpoint` before anything changes, then applied
  to the target with `git read-tree -m -u`, which never overwrites differing files.
  Each step rolls back the earlier ones on failure.
- A dirty target is refused (`target_changes`) unless the client says to
  `commit`, `stash`, or `discard` its changes first.
- Refused while the thread runs, while it still has background agents or commands
  (re-pointing detaches the provider session that runs them), while another thread
  runs in the target, or while another move of the same thread is in flight.
- The source worktree is removed by default when moving to the project checkout,
  and kept (detached, clean) when moving between worktrees.
- Git-ignored files (such as `.env`) are not moved.

Where it lives:

| Layer          | Fork code                                                                                                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contracts      | `packages/contracts/src/git.ts` (`GitListThreadMoveTargets*`, `GitMoveThreadToWorktree*`, `GitMoveThreadToWorktreeFailureReason`), RPCs `git.listThreadMoveTargets` / `git.moveThreadToWorktree` in `rpc.ts` |
| Capability     | `threadMoveToWorktree` in `packages/contracts/src/environment.ts`, set in `apps/server/src/environment/ServerEnvironment.ts`                                                                                 |
| Permissions    | `git.moveThreadToWorktree` needs source-control write + orchestration operate (`packages/contracts/src/clientRpcPermissions.ts`); list needs orchestration read (`apps/server/src/auth/RpcAuthorization.ts`) |
| Server service | `apps/server/src/git/ThreadCheckoutService.ts` (+ `.test.ts`), wired in `apps/server/src/server.ts` (`layerOrchestrationApplication`) and `apps/server/src/ws.ts`                                            |
| Client runtime | `threadMoveTargets` query and `moveThreadToWorktree` command in `packages/client-runtime/src/state/git.ts`                                                                                                   |
| Web            | `apps/web/src/components/MoveToWorktreeDialog.tsx` (host mounted in `routes/__root.tsx` `appHosts`), menu item in `threadActionMenu.logic.ts`, handlers in `Sidebar.tsx` and `hooks/useThreadActionMenu.ts`  |
| Docs           | "Move a worktree thread to another worktree" in `docs/user/thread-sidebar.md`                                                                                                                                |

Not supported: mobile (no menu entry) and MCP tools for agents.

## 2. Unsigned Windows installer CI

`.github/workflows/fork-windows-installer.yml` builds an unsigned Windows desktop
installer from `main` (artifact of the workflow run). It embeds no Linux CLI
archive (`--wsl-runtime`), so the installer has no WSL backend: the fork only
uses the Windows backend. Keep its build steps in step with upstream
`release-desktop.yml` after each upstream merge.

## 3. Native Windows builds pass the payload file budget

Upstream cross-builds Windows releases on Linux, which skips the prepared server
bytecode (`resources/server-compile-cache`, ~20 files). The fork builds natively
on Windows, where that cache pushed the payload over
`WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT`. `countPayloadFiles` in
`scripts/build-desktop-artifact.ts` leaves that directory out of the budget.

## Merging upstream

- Merge stable tags (`vX.Y.Z`, no `-nightly`/`-preview` suffix), e.g.
  `git fetch upstream --tags && git merge vX.Y.Z`.
- Conflicts usually land where the fork hooks into upstream files: `Sidebar.tsx`,
  `useThreadActionMenu.ts`, `threadActionMenu.logic(.test).ts`, `routes/__root.tsx`,
  `state/entities.ts`, `server.ts`, `RpcAuthorization.ts`, `clientRpcPermissions.ts`.
  Prefer taking the upstream version and re-adding the fork lines listed above.
- After merging, typecheck `apps/server`, `apps/web`, `packages/contracts`, and run
  `apps/server/src/git/ThreadCheckoutService.test.ts` and
  `apps/web/src/components/threadActionMenu.logic.test.ts`.
