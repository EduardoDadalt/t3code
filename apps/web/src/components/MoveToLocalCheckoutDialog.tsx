import type {
  EnvironmentId,
  GitLocalCheckoutChangesResolution,
  GitMoveThreadToLocalCheckoutResult,
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
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";
import { Toggle, ToggleGroup } from "./ui/toggle-group";

interface MoveToLocalCheckoutRequest {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly projectRoot: string;
  readonly branch: string | null;
  readonly worktreePath: string;
}

type Request = MoveToLocalCheckoutRequest & {
  readonly resolve: (result: GitMoveThreadToLocalCheckoutResult | null) => void;
};
const useRequest = create<{ request: Request | null }>(() => ({ request: null }));

/**
 * Asks how to move a worktree thread into its project's checkout and runs the
 * move. Resolves with the result, or null when the user cancels.
 */
function requestMoveToLocalCheckout(
  input: MoveToLocalCheckoutRequest,
): Promise<GitMoveThreadToLocalCheckoutResult | null> {
  useRequest.getState().request?.resolve(null);
  return new Promise((resolve) => useRequest.setState({ request: { ...input, resolve } }));
}

/** The thread action menu's "Move to current checkout": asks, moves, and reports. */
export async function moveThreadToLocalCheckout(input: MoveToLocalCheckoutRequest) {
  const result = await requestMoveToLocalCheckout(input);
  if (result === null) return;
  toastManager.add({
    type: "success",
    title: "Moved to current checkout",
    description: result.worktreeRemoved
      ? `${input.threadTitle} now works in ${formatWorktreePathForDisplay(input.projectRoot)}.`
      : `The worktree at ${result.worktreePath} could not be removed. Delete it when you no longer need it.`,
  });
}

function finish(result: GitMoveThreadToLocalCheckoutResult | null) {
  const request = useRequest.getState().request;
  useRequest.setState({ request: null });
  request?.resolve(result);
}

export function MoveToLocalCheckoutDialogHost() {
  const request = useRequest((state) => state.request);
  useEffect(() => () => finish(null), []);
  return request ? <MoveToLocalCheckoutDialog key={request.threadId} request={request} /> : null;
}

type LocalChangesChoice = GitLocalCheckoutChangesResolution["type"];

function MoveToLocalCheckoutDialog({ request }: { request: Request }) {
  const id = useId();
  const [choice, setChoice] = useState<LocalChangesChoice>("commit");
  const [commitMessage, setCommitMessage] = useState("");
  const [isMoving, setIsMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const moveThread = useAtomCommand(gitEnvironment.moveThreadToLocalCheckout, {
    reportFailure: false,
  });
  const localStatus = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId: request.environmentId,
      input: { cwd: request.projectRoot },
    }),
  );
  const changedFileCount = localStatus.data?.workingTree.files.length ?? 0;
  const hasLocalChanges = localStatus.data?.hasWorkingTreeChanges === true;
  const checkoutName = formatWorktreePathForDisplay(request.projectRoot);
  const worktreeName = formatWorktreePathForDisplay(request.worktreePath);
  const canSubmit =
    !isMoving &&
    localStatus.data !== null &&
    (!hasLocalChanges || choice !== "commit" || commitMessage.trim().length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    setIsMoving(true);
    setError(null);
    const localChanges: GitLocalCheckoutChangesResolution | undefined = !hasLocalChanges
      ? undefined
      : choice === "commit"
        ? { type: "commit", message: commitMessage.trim() }
        : { type: choice };
    const result = await moveThread({
      environmentId: request.environmentId,
      input: {
        threadId: request.threadId,
        ...(localChanges === undefined ? {} : { localChanges }),
      },
    });
    if (result._tag === "Success") {
      finish(result.value);
      return;
    }
    setIsMoving(false);
    if (isAtomCommandInterrupted(result)) return;
    const failure = squashAtomCommandFailure(result);
    setError(failure instanceof Error ? failure.message : "The thread could not be moved.");
    localStatus.refresh();
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
            <DialogTitle>Move to current checkout</DialogTitle>
            <DialogDescription>
              {request.branch ? (
                <>
                  Checks out <code>{request.branch}</code> in {checkoutName}
                </>
              ) : (
                <>Checks out the worktree's commit in {checkoutName}</>
              )}
              , brings over the uncommitted changes from {worktreeName}, and removes the worktree.
              Ignored files, such as <code>.env</code>, are not moved.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              {localStatus.data === null ? (
                <p className="flex items-center gap-2 text-muted-foreground text-sm">
                  <Spinner size="sm" aria-hidden />
                  Checking {checkoutName} for uncommitted changes…
                </p>
              ) : hasLocalChanges ? (
                <>
                  <p className="text-sm">
                    {checkoutName} has {changedFileCount} uncommitted change
                    {changedFileCount === 1 ? "" : "s"}. Choose what happens to{" "}
                    {changedFileCount === 1 ? "it" : "them"} first.
                  </p>
                  <ToggleGroup
                    aria-label="Uncommitted changes in the current checkout"
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
                        placeholder="Describe the changes in the current checkout"
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
                </>
              ) : null}
              {error ? <p className="text-destructive-foreground text-sm">{error}</p> : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={isMoving} onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant={hasLocalChanges && choice === "discard" ? "destructive" : "default"}
              disabled={!canSubmit}
            >
              {isMoving ? <Spinner aria-hidden /> : null}
              {hasLocalChanges && choice === "discard" ? "Discard and move" : "Move"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
