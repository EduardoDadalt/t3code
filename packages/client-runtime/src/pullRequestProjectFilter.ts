import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

interface FilterProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
  readonly repositoryIdentity?: { readonly canonicalKey?: string | undefined } | null | undefined;
  readonly title: string;
  readonly workspaceRoot: string;
}

function distinguishTitles<Project extends FilterProject>(
  projects: ReadonlyArray<Project>,
  suffix: (project: Project) => string,
) {
  const counts = new Map<string, number>();
  for (const project of projects) {
    counts.set(project.title, (counts.get(project.title) ?? 0) + 1);
  }
  return projects.map((project) =>
    (counts.get(project.title) ?? 0) > 1
      ? { ...project, title: `${project.title} · ${suffix(project)}` }
      : project,
  );
}

export function pullRequestFilterProjects<Project extends FilterProject>(
  projects: ReadonlyArray<Project>,
  environmentLabels: ReadonlyMap<EnvironmentId, string>,
  selectedProject?: Pick<FilterProject, "id" | "environmentId">,
) {
  const byRepository = new Map<string, Project>();
  for (const project of projects) {
    const repository = project.repositoryIdentity?.canonicalKey?.toLowerCase();
    const key = JSON.stringify([
      project.environmentId,
      repository ? ["repository", repository] : ["project", project.id],
    ]);
    const selected =
      project.id === selectedProject?.id && project.environmentId === selectedProject.environmentId;
    if (!byRepository.has(key) || selected) byRepository.set(key, project);
  }

  const byServer = distinguishTitles(
    [...byRepository.values()],
    (project) => environmentLabels.get(project.environmentId) ?? project.environmentId,
  );
  const byPath = distinguishTitles(byServer, (project) => project.workspaceRoot);
  const byEnvironment = distinguishTitles(byPath, (project) => project.environmentId);
  return distinguishTitles(byEnvironment, (project) => project.id).sort((left, right) =>
    left.title.localeCompare(right.title),
  );
}

/** The repository owners (organizations, users, top-level groups) across projects, once each. */
export function pullRequestOwnerOptions(
  projects: ReadonlyArray<{
    readonly repositoryIdentity?: { readonly owner?: string | undefined } | null | undefined;
  }>,
): ReadonlyArray<string> {
  const owners = new Map<string, string>();
  for (const project of projects) {
    const owner = project.repositoryIdentity?.owner;
    if (owner !== undefined && !owners.has(owner.toLowerCase())) {
      owners.set(owner.toLowerCase(), owner);
    }
  }
  return [...owners.values()].sort((left, right) =>
    left.localeCompare(right, undefined, { sensitivity: "base" }),
  );
}

/** Whether a listed `owner/name` repository belongs to the chosen owner. */
export function pullRequestRepositoryHasOwner(repository: string, owner: string): boolean {
  return repository.split("/", 1)[0]?.toLowerCase() === owner.toLowerCase();
}
