/**
 * GitHub Projects v2 GraphQL adapter.
 *
 * Implements the `ProjectsV2GitHubPort` that `@lexi/governance`'s
 * `ProjectsV2Service` depends on. Projects v2 has no REST surface at all, so
 * every call here goes through GitHub's GraphQL API.
 *
 * The port is declared structurally (not imported from @lexi/governance) to keep
 * the dependency direction one-way: @lexi/governance already depends on
 * @lexi/github, so importing back would create a cycle. The shapes are asserted
 * against each other by the governance-side unit tests.
 *
 * EXTERNAL_CONFIGURATION: the GitHub App needs the organisation-level
 * "Projects" permission (read-only for board reads, read & write for
 * placement/status mutations). Repository-level permissions are not sufficient —
 * an org project is not owned by a repository.
 */

import type { GithubGraphqlClient } from "./octokit.factory";

export type ProjectFieldType = "single_select" | "iteration" | "text" | "number" | "date";

export interface ProjectFieldOption {
  id: string;
  name: string;
}

export interface ProjectField {
  id: string;
  name: string;
  type: ProjectFieldType;
  options?: ProjectFieldOption[];
}

export interface ProjectItem {
  id: string;
  contentId: string;
  contentType: "Issue" | "PullRequest" | "DraftIssue";
  issueNumber?: number;
  issueRepository?: string;
  title?: string;
  status?: string;
  iteration?: string;
  priority?: string;
  assignees?: string[];
}

/** Field value accepted by `updateProjectItemField`. */
export type ProjectFieldValue =
  | string
  | { singleSelectOptionId: string }
  | { iterationId: string };

export interface ProjectsV2GraphqlAdapterLogger {
  log(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

/** GitHub's `ProjectV2CustomFieldType` / `ProjectV2FieldType` enum values we care about. */
function toFieldType(dataType: string | undefined): ProjectFieldType {
  switch (dataType) {
    case "SINGLE_SELECT":
      return "single_select";
    case "ITERATION":
      return "iteration";
    case "NUMBER":
      return "number";
    case "DATE":
      return "date";
    default:
      // TEXT, TITLE, ASSIGNEES, LABELS, MILESTONE, REPOSITORY, REVIEWERS,
      // LINKED_PULL_REQUESTS, TRACKS… all read as opaque text. Falling back
      // rather than throwing keeps an unfamiliar field from breaking the whole
      // board read.
      return "text";
  }
}

const PROJECT_FIELDS_FRAGMENT = `
  fields(first: 50) {
    nodes {
      ... on ProjectV2FieldCommon { id name dataType }
      ... on ProjectV2SingleSelectField {
        id
        name
        dataType
        options { id name }
      }
      ... on ProjectV2IterationField {
        id
        name
        dataType
        configuration {
          iterations { id title }
          completedIterations { id title }
        }
      }
    }
  }
`;

const GET_PROJECT_QUERY = (ownerField: "organization" | "user") => `
  query($login: String!, $number: Int!) {
    ${ownerField}(login: $login) {
      projectV2(number: $number) {
        id
        title
        ${PROJECT_FIELDS_FRAGMENT}
      }
    }
  }
`;

const LIST_ITEMS_QUERY = (ownerField: "organization" | "user") => `
  query($login: String!, $number: Int!, $first: Int!, $after: String) {
    ${ownerField}(login: $login) {
      projectV2(number: $number) {
        items(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id
            type
            content {
              __typename
              ... on Issue {
                id
                number
                title
                repository { nameWithOwner }
                assignees(first: 10) { nodes { login } }
              }
              ... on PullRequest {
                id
                number
                title
                repository { nameWithOwner }
                assignees(first: 10) { nodes { login } }
              }
              ... on DraftIssue { id title }
            }
            fieldValues(first: 20) {
              nodes {
                __typename
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldIterationValue {
                  title
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldTextValue {
                  text
                  field { ... on ProjectV2FieldCommon { name } }
                }
                ... on ProjectV2ItemFieldNumberValue {
                  number
                  field { ... on ProjectV2FieldCommon { name } }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const ADD_ITEM_MUTATION = `
  mutation($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
      item { id }
    }
  }
`;

const UPDATE_FIELD_MUTATION = `
  mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
    updateProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }
    ) {
      projectV2Item { id }
    }
  }
`;

/**
 * Resolves an issue *or* pull request node id in a single round trip.
 *
 * GitHub numbers issues and PRs from one shared sequence per repository, so a
 * number the caller believes is an issue may in fact be a PR. Asking for both
 * and preferring the issue avoids a spurious "not found" for board items that
 * are legitimately PRs.
 */
const NODE_ID_QUERY = `
  query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      issue(number: $number) { id }
      pullRequest(number: $number) { id }
    }
  }
`;

interface RawFieldNode {
  id?: string;
  name?: string;
  dataType?: string;
  options?: Array<{ id: string; name: string }>;
  configuration?: {
    iterations?: Array<{ id: string; title: string }>;
    completedIterations?: Array<{ id: string; title: string }>;
  };
}

interface RawProjectPayload {
  projectV2?: {
    id: string;
    title: string;
    fields?: { nodes?: Array<RawFieldNode | null> };
  } | null;
}

interface RawFieldValueNode {
  __typename?: string;
  name?: string;
  title?: string;
  text?: string;
  number?: number;
  field?: { name?: string };
}

interface RawItemNode {
  id: string;
  type?: string;
  content?: {
    __typename?: string;
    id?: string;
    number?: number;
    title?: string;
    repository?: { nameWithOwner?: string };
    assignees?: { nodes?: Array<{ login?: string }> };
  } | null;
  fieldValues?: { nodes?: Array<RawFieldValueNode | null> };
}

interface RawItemsPayload {
  projectV2?: {
    items?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      nodes?: Array<RawItemNode | null>;
    };
  } | null;
}

function isNotFound(error: unknown): boolean {
  const err = error as { status?: number; errors?: Array<{ type?: string }> };
  if (err?.status === 404) return true;
  return Boolean(err?.errors?.some((e) => e?.type === "NOT_FOUND"));
}

function toContentType(typename: string | undefined, itemType: string | undefined): ProjectItem["contentType"] {
  if (typename === "Issue" || itemType === "ISSUE") return "Issue";
  if (typename === "PullRequest" || itemType === "PULL_REQUEST") return "PullRequest";
  return "DraftIssue";
}

/** Reads a named field value off a project item, matching the field name case-insensitively. */
function readFieldValue(nodes: Array<RawFieldValueNode | null>, fieldName: string): string | undefined {
  for (const node of nodes) {
    if (!node) continue;
    if (node.field?.name?.toLowerCase() !== fieldName.toLowerCase()) continue;

    // The value lives under a different key per value type.
    const value = node.name ?? node.title ?? node.text ?? (typeof node.number === "number" ? String(node.number) : undefined);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

/**
 * GraphQL-backed implementation of the Projects v2 GitHub port.
 *
 * Read methods return `null`/empty on a missing project (the service treats that
 * as a user-facing "not found"), while mutations throw — `ProjectsV2Service`
 * wraps every mutation in try/catch and converts the thrown message into an
 * honest `{ added: false, reason }` result, so throwing here is what surfaces a
 * real GitHub error to the operator instead of silently reporting success.
 */
export class ProjectsV2GraphqlAdapter {
  constructor(
    private readonly graphql: GithubGraphqlClient,
    private readonly logger?: ProjectsV2GraphqlAdapterLogger,
  ) {}

  /**
   * Runs an owner-scoped query against `organization`, falling back to `user`.
   *
   * A project number is scoped to its owner, and that owner may be either an org
   * or a user account. Trying the org first matches the common case (team
   * boards) without making personal boards unreachable.
   */
  private async queryByOwner<TPayload>(
    build: (ownerField: "organization" | "user") => string,
    variables: Record<string, unknown>,
  ): Promise<TPayload | null> {
    try {
      const data = await this.graphql<Record<string, TPayload | null>>(build("organization"), variables);
      const payload = data?.organization;
      if (payload) return payload;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    try {
      const data = await this.graphql<Record<string, TPayload | null>>(build("user"), variables);
      return data?.user ?? null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async getProject(
    org: string,
    projectNumber: number,
  ): Promise<{ id: string; title: string; fields: ProjectField[] } | null> {
    const payload = await this.queryByOwner<RawProjectPayload>(GET_PROJECT_QUERY, {
      login: org,
      number: projectNumber,
    });

    const project = payload?.projectV2;
    if (!project) return null;

    const fields: ProjectField[] = [];
    for (const node of project.fields?.nodes ?? []) {
      if (!node?.id || !node.name) continue;

      const type = toFieldType(node.dataType);
      const field: ProjectField = { id: node.id, name: node.name, type };

      if (type === "single_select" && node.options) {
        field.options = node.options.map((o) => ({ id: o.id, name: o.name }));
      } else if (type === "iteration" && node.configuration) {
        // Present iterations as options so callers can resolve a name → id the
        // same way they do for single-selects. Active iterations come first;
        // "Sprint 5" should resolve to the live one, not a completed namesake.
        const iterations = [
          ...(node.configuration.iterations ?? []),
          ...(node.configuration.completedIterations ?? []),
        ];
        field.options = iterations.map((i) => ({ id: i.id, name: i.title }));
      }

      fields.push(field);
    }

    return { id: project.id, title: project.title, fields };
  }

  async listProjectItems(
    org: string,
    projectNumber: number,
    cursor?: string,
    limit = 50,
  ): Promise<{ items: ProjectItem[]; hasNext: boolean; endCursor?: string }> {
    // GitHub caps connection pages at 100.
    const first = Math.min(Math.max(Math.trunc(limit) || 50, 1), 100);

    const payload = await this.queryByOwner<RawItemsPayload>(LIST_ITEMS_QUERY, {
      login: org,
      number: projectNumber,
      first,
      after: cursor ?? null,
    });

    const connection = payload?.projectV2?.items;
    if (!connection) return { items: [], hasNext: false };

    const items: ProjectItem[] = [];
    for (const node of connection.nodes ?? []) {
      if (!node?.id) continue;
      if (node.type === "REDACTED") continue; // Item the App cannot see.

      const content = node.content ?? undefined;
      const fieldValues = node.fieldValues?.nodes ?? [];

      const item: ProjectItem = {
        id: node.id,
        contentId: content?.id ?? "",
        contentType: toContentType(content?.__typename, node.type),
        issueNumber: content?.number,
        issueRepository: content?.repository?.nameWithOwner,
        title: content?.title,
        status: readFieldValue(fieldValues, "status"),
        iteration: readFieldValue(fieldValues, "iteration") ?? readFieldValue(fieldValues, "sprint"),
        priority: readFieldValue(fieldValues, "priority"),
        assignees: (content?.assignees?.nodes ?? [])
          .map((a) => a?.login)
          .filter((login): login is string => Boolean(login)),
      };

      items.push(item);
    }

    // `hasNextPage` false must not be reported alongside a cursor, or a caller
    // looping on the cursor would never terminate.
    const hasNext = Boolean(connection.pageInfo?.hasNextPage);
    return {
      items,
      hasNext,
      endCursor: hasNext ? connection.pageInfo?.endCursor ?? undefined : undefined,
    };
  }

  async addIssueToProject(projectId: string, issueNodeId: string): Promise<string> {
    const data = await this.graphql<{
      addProjectV2ItemById?: { item?: { id?: string } | null } | null;
    }>(ADD_ITEM_MUTATION, { projectId, contentId: issueNodeId });

    const itemId = data?.addProjectV2ItemById?.item?.id;
    if (!itemId) {
      throw new Error(
        "addProjectV2ItemById returned no item id. The GitHub App likely lacks the " +
          'organisation "Projects" read & write permission.',
      );
    }

    this.logger?.log(`Added content ${issueNodeId} to project ${projectId} (item ${itemId})`);
    return itemId;
  }

  async updateProjectItemField(
    projectId: string,
    itemId: string,
    fieldId: string,
    value: ProjectFieldValue,
  ): Promise<void> {
    // `ProjectV2FieldValue` is a oneOf input: exactly one key may be set, and it
    // must match the target field's data type.
    const graphqlValue =
      typeof value === "string"
        ? { text: value }
        : "singleSelectOptionId" in value
          ? { singleSelectOptionId: value.singleSelectOptionId }
          : { iterationId: value.iterationId };

    await this.graphql<{ updateProjectV2ItemFieldValue?: unknown }>(UPDATE_FIELD_MUTATION, {
      projectId,
      itemId,
      fieldId,
      value: graphqlValue,
    });
  }

  async getIssueNodeId(owner: string, repo: string, issueNumber: number): Promise<string> {
    let data: {
      repository?: {
        issue?: { id?: string } | null;
        pullRequest?: { id?: string } | null;
      } | null;
    } | null = null;

    try {
      data = await this.graphql(NODE_ID_QUERY, { owner, repo, number: issueNumber });
    } catch (error) {
      // Asking for both issue(number:) and pullRequest(number:) means one of the
      // two is always NOT_FOUND, and GitHub reports partial errors alongside
      // usable data. Only treat it as fatal when nothing came back.
      if (!isNotFound(error)) throw error;
      const partial = (error as { data?: typeof data }).data;
      if (!partial) throw error;
      data = partial;
    }

    const nodeId = data?.repository?.issue?.id ?? data?.repository?.pullRequest?.id;
    if (!nodeId) {
      throw new Error(`Issue ${owner}/${repo}#${issueNumber} not found (no GraphQL node id).`);
    }
    return nodeId;
  }
}
