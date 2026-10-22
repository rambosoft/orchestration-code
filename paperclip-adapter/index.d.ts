export type IssueProject = { projectId?: string | null };

export function resolveProjectId(issue: IssueProject, configuredProjectId?: string | null): string | undefined;
