import type {
  EnvironmentId,
  GitMoveThreadToWorktreeResult,
  GitThreadMoveTarget,
  GitWorktreeChangesResolution,
  ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useId, useState } from "react";
import { create } from "zustand";

import { gitEnvironment } from "../state/git";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { vcsEnvironment } from "../state/vcs";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Radio, RadioGroup } from "./ui/radio-group";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

/** Changed files a dirty target lists before summarizing the rest. */
const LISTED_CHANGED_FILES = 8;

interface MoveToWorktreeRequest {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly branch: string | null;
  readonly worktreePath: string;
}

interface MoveToWorktreeOutcome {
  readonly target: GitThreadMoveTarget;
  readonly removeSourceRequested: boolean;
  readonly result: GitMoveThreadToWorktreeResult;
}

type Request = MoveToWorktreeRequest & {
  readonly resolve: (outcome: MoveToWorktreeOutcome | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/**
 * Asks where to move a worktree thread and runs the move. Resolves with the
 * outcome, or null when the user cancels.
 */
function requestMoveToWorktree(
  input: MoveToWorktreeRequest,
): Promise<MoveToWorktreeOutcome | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { ...input, resolve } }));
}

function targetName(target: GitThreadMoveTarget): string {
  return target.isProjectRoot ? "the current checkout" : formatWorktreePathForDisplay(target.path);
}

/** The thread action menu's "Move to worktree…": asks, moves, and reports. */
export async function moveThreadToWorktree(input: MoveToWorktreeRequest) {
  const outcome = await requestMoveToWorktree(input);
  if (outcome === null) return;
  const { target, removeSourceRequested, result } = outcome;
  const switched =
    result.previousBranch !== null && result.previousBranch !== result.branch
      ? ` It was on ${result.previousBranch}.`
      : "";
  const sourceName = formatWorktreePathForDisplay(result.sourceWorktreePath);
  const left = result.sourceWorktreeRemoved
    ? ""
    : removeSourceRequested
      ? ` The worktree at ${result.sourceWorktreePath} could not be removed. Delete it when you no longer need it.`
      : ` ${sourceName} stays, detached and without the moved changes.`;
  toastManager.add({
    type: "success",
    title: `Moved to ${targetName(target)}`,
    description: `${input.threadTitle} now works in ${formatWorktreePathForDisplay(target.path)}.${switched}${left}`,
  });
}

function finish(outcome: MoveToWorktreeOutcome | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(outcome);
}

export function MoveToWorktreeDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <MoveToWorktreeDialog key={request.threadId} request={request} /> : null;
}

type TargetChangesChoice = GitWorktreeChangesResolution["type"];

function MoveToWorktreeDialog({ request }: { request: Request }) {
  const id = useId();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  // Null follows the target: leaving for the current checkout removes the
  // worktree, moving between worktrees keeps it.
  const [removeSourceChoice, setRemoveSourceChoice] = useState<boolean | null>(null);
  const [choice, setChoice] = useState<TargetChangesChoice>("commit");
  const [commitMessage, setCommitMessage] = useState("");
  const [isMoving, setIsMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moveThread = useAtomCommand(gitEnvironment.moveThreadToWorktree, {
    reportFailure: false,
  });
  const targets = useEnvironmentQuery(
    gitEnvironment.threadMoveTargets({
      environmentId: request.environmentId,
      input: { threadId: request.threadId },
    }),
  );
  const target =
    targets.data?.targets.find((candidate) => candidate.path === selectedPath) ??
    targets.data?.targets[0] ??
    null;
  const targetStatus = useEnvironmentQuery(
    target === null
      ? null
      : vcsEnvironment.status({
          environmentId: request.environmentId,
          input: { cwd: target.path },
        }),
  );
  const changedFiles = targetStatus.data?.workingTree.files ?? [];
  const hasTargetChanges = targetStatus.data?.hasWorkingTreeChanges === true;
  const removeSource = removeSourceChoice ?? target?.isProjectRoot ?? false;
  const worktreeName = formatWorktreePathForDisplay(request.worktreePath);
  const branchLabel = request.branch ? <code>{request.branch}</code> : "the worktree's commit";
  const canSubmit =
    !isMoving &&
    target !== null &&
    targetStatus.data !== null &&
    (!hasTargetChanges || choice !== "commit" || commitMessage.trim().length > 0);

  const submit = async () => {
    if (!canSubmit || target === null) return;
    setIsMoving(true);
    setError(null);
    const targetChanges: GitWorktreeChangesResolution | undefined = !hasTargetChanges
      ? undefined
      : choice === "commit"
        ? { type: "commit", message: commitMessage.trim() }
        : { type: choice };
    const result = await moveThread({
      environmentId: request.environmentId,
      input: {
        threadId: request.threadId,
        targetPath: target.path,
        removeSourceWorktree: removeSource,
        ...(targetChanges === undefined ? {} : { targetChanges }),
      },
    });
    if (result._tag === "Success") {
      finish({ target, removeSourceRequested: removeSource, result: result.value });
      return;
    }
    setIsMoving(false);
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "The thread could not be moved.");
    targetStatus.refresh();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isMoving) finish(null);
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Move to worktree</DialogTitle>
            <DialogDescription>
              Checks out {branchLabel} in the worktree you choose, with the uncommitted changes from{" "}
              {worktreeName}. Ignored files, such as <code>.env</code>, are not moved.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              {targets.data === null ? (
                targets.error ? (
                  <p className="text-destructive-foreground text-sm">{targets.error}</p>
                ) : (
                  <p className="flex items-center gap-2 text-muted-foreground text-sm">
                    <Spinner size="sm" aria-hidden />
                    Looking for the project's worktrees…
                  </p>
                )
              ) : target === null ? (
                <p className="text-muted-foreground text-sm">
                  This project has no other worktree to move to.
                </p>
              ) : (
                <>
                  <RadioGroup
                    aria-label="Worktree to move to"
                    value={target.path}
                    onValueChange={(value) => {
                      setSelectedPath(value);
                      setRemoveSourceChoice(null);
                      setError(null);
                    }}
                  >
                    {targets.data.targets.map((candidate) => (
                      <label
                        key={candidate.path}
                        className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-2.5 text-sm"
                      >
                        <Radio value={candidate.path} />
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">
                            {candidate.isProjectRoot
                              ? "Current checkout"
                              : formatWorktreePathForDisplay(candidate.path)}
                          </span>
                          <span className="truncate text-muted-foreground text-xs">
                            {candidate.branch ?? "Detached"} · {candidate.path}
                          </span>
                        </span>
                      </label>
                    ))}
                  </RadioGroup>
                  {target.branch !== null && target.branch !== request.branch ? (
                    <p className="text-muted-foreground text-sm">
                      {formatWorktreePathForDisplay(target.path)} switches from{" "}
                      <code>{target.branch}</code> to {branchLabel}.
                    </p>
                  ) : null}
                  {targetStatus.data === null ? (
                    <p className="flex items-center gap-2 text-muted-foreground text-sm">
                      <Spinner size="sm" aria-hidden />
                      Checking {formatWorktreePathForDisplay(target.path)} for uncommitted changes…
                    </p>
                  ) : hasTargetChanges ? (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm">
                        {formatWorktreePathForDisplay(target.path)} has {changedFiles.length}{" "}
                        uncommitted change{changedFiles.length === 1 ? "" : "s"}. Choose what
                        happens to {changedFiles.length === 1 ? "it" : "them"} first.
                      </p>
                      <ul className="flex flex-col gap-0.5 font-mono text-muted-foreground text-xs">
                        {changedFiles.slice(0, LISTED_CHANGED_FILES).map((file) => (
                          <li key={file.path} className="truncate">
                            {file.path}
                          </li>
                        ))}
                        {changedFiles.length > LISTED_CHANGED_FILES ? (
                          <li>and {changedFiles.length - LISTED_CHANGED_FILES} more</li>
                        ) : null}
                      </ul>
                      <ToggleGroup
                        aria-label="Uncommitted changes in the target worktree"
                        className="w-full *:flex-1"
                        value={[choice]}
                        onValueChange={(next) => {
                          const value = next[0];
                          if (value === "commit" || value === "stash" || value === "discard") {
                            setChoice(value);
                          }
                        }}
                      >
                        <Toggle value="commit">Commit</Toggle>
                        <Toggle value="stash">Stash</Toggle>
                        <Toggle value="discard">Discard</Toggle>
                      </ToggleGroup>
                      {choice === "commit" ? (
                        <div className="flex flex-col gap-1.5">
                          <Label htmlFor={`${id}-message`}>Commit message</Label>
                          <Input
                            id={`${id}-message`}
                            value={commitMessage}
                            onChange={(event) => setCommitMessage(event.target.value)}
                            placeholder="Describe the changes in the target worktree"
                            autoFocus
                          />
                        </div>
                      ) : (
                        <p className="text-muted-foreground text-sm">
                          {choice === "stash"
                            ? "The changes are saved with git stash, so you can bring them back later."
                            : "The changes are deleted permanently."}
                        </p>
                      )}
                    </div>
                  ) : null}
                  <Label>
                    <Checkbox
                      checked={removeSource}
                      onCheckedChange={(checked) => setRemoveSourceChoice(checked === true)}
                    />
                    Remove {worktreeName} after moving
                  </Label>
                  {removeSource ? null : (
                    <p className="text-muted-foreground text-sm">
                      {worktreeName} stays, detached and without the moved changes.
                    </p>
                  )}
                </>
              )}
              {error ? <p className="text-destructive-foreground text-sm">{error}</p> : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={isMoving} onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={hasTargetChanges && choice === "discard" ? "destructive" : "default"}
              disabled={!canSubmit}
            >
              {isMoving ? <Spinner aria-hidden /> : null}
              {hasTargetChanges && choice === "discard" ? "Discard and move" : "Move"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
