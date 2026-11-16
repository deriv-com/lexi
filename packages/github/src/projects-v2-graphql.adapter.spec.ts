/**
 * Unit tests for the Projects v2 GraphQL adapter.
 *
 * The GraphQL client is faked so the queries themselves are asserted — Projects
 * v2 responses are deeply nested unions and the mapping is where the bugs live.
 */
import { describe, expect, it, vi } from "vitest";
import { ProjectsV2GraphqlAdapter } from "./projects-v2-graphql.adapter";
import { graphqlFromOctokit } from "./octokit.factory";

/** Builds a graphql fake that dispatches on a substring of the query. */
function fakeGraphql(handlers: Array<{ match: string; respond: (vars: Record<string, unknown>) => unknown }>) {
  return vi.fn(async (query: string, variables?: Record<string, unknown>) => {
    const handler = handlers.find((h) => query.includes(h.match));
    if (!handler) throw new Error(`Unexpected query: ${query.slice(0, 120)}`);
    const result = handler.respond(variables ?? {});
    if (result instanceof Error) throw result;
    return result;
  });
}

function notFoundError() {
  return Object.assign(new Error("Could not resolve to an Organization"), {
    errors: [{ type: "NOT_FOUND" }],
  });
}

describe("ProjectsV2GraphqlAdapter", () => {
  describe("getProject", () => {
    it("maps fields and single-select options", async () => {
      const graphql = fakeGraphql([
        {
          match: "projectV2(number: $number)",
          respond: () => ({
            organization: {
              projectV2: {
                id: "PVT_1",
                title: "Mobile Team",
                fields: {
                  nodes: [
                    {
                      id: "F_status",
                      name: "Status",
                      dataType: "SINGLE_SELECT",
                      options: [
                        { id: "opt_todo", name: "Todo" },
                        { id: "opt_prog", name: "In Progress" },
                      ],
                    },
                    { id: "F_title", name: "Title", dataType: "TITLE" },
                  ],
                },
              },
            },
          }),
        },
      ]);

      const adapter = new ProjectsV2GraphqlAdapter(graphql as never);
      const project = await adapter.getProject("acme", 1);

      expect(project).not.toBeNull();
      expect(project?.id).toBe("PVT_1");
      expect(project?.title).toBe("Mobile Team");

      const status = project?.fields.find((f) => f.name === "Status");
      expect(status?.type).toBe("single_select");
      expect(status?.options?.map((o) => o.id)).toEqual(["opt_todo", "opt_prog"]);

      // TITLE is not one of the modelled types, so it degrades to text.
      expect(project?.fields.find((f) => f.name === "Title")?.type).toBe("text");
    });

    it("exposes iterations as options, active ones first", async () => {
      const graphql = fakeGraphql([
        {
          match: "projectV2(number: $number)",
          respond: () => ({
            organization: {
              projectV2: {
                id: "PVT_1",
                title: "Board",
                fields: {
                  nodes: [
                    {
                      id: "F_it",
                      name: "Iteration",
                      dataType: "ITERATION",
                      configuration: {
                        iterations: [{ id: "it_live", title: "Sprint 5" }],
                        completedIterations: [{ id: "it_done", title: "Sprint 4" }],
                      },
                    },
                  ],
                },
              },
            },
          }),
        },
      ]);

      const adapter = new ProjectsV2GraphqlAdapter(graphql as never);
      const project = await adapter.getProject("acme", 1);
      const field = project?.fields[0];

      expect(field?.type).toBe("iteration");
      expect(field?.options).toEqual([
        { id: "it_live", name: "Sprint 5" },
        { id: "it_done", name: "Sprint 4" },
      ]);
    });

    it("returns null when the project does not exist", async () => {
      const graphql = fakeGraphql([
        { match: "projectV2(number: $number)", respond: () => notFoundError() },
      ]);

      const adapter = new ProjectsV2GraphqlAdapter(graphql as never);
      await expect(adapter.getProject("acme", 99)).resolves.toBeNull();
    });

    it("falls back to a user-owned project when the org lookup misses", async () => {
      let call = 0;
      const graphql = vi.fn(async (query: string) => {
        call += 1;
        if (query.includes("organization(login:")) throw notFoundError();
        expect(query).toContain("user(login:");
        return { user: { projectV2: { id: "PVT_u", title: "Personal", fields: { nodes: [] } } } };
      });

      const adapter = new ProjectsV2GraphqlAdapter(graphql as never);
      const project = await adapter.getProject("some-user", 3);

      expect(project?.id).toBe("PVT_u");
      expect(call).toBe(2);
    });

    it("propagates non-NOT_FOUND errors instead of reporting a missing project", async () => {
      const graphql = vi.fn(async () => {
        throw Object.assign(new Error("Bad credentials"), { status: 401 });
      });

      const adapter = new ProjectsV2GraphqlAdapter(graphql as never);
      await expect(adapter.getProject("acme", 1)).rejects.toThrow("Bad credentials");
    });
  });

  describe("listProjectItems", () => {
    const itemsResponse = {
      organization: {
        projectV2: {
          items: {
            pageInfo: { hasNextPage: true, endCursor: "CUR_2" },
            nodes: [
              {
                id: "PVTI_1",
                type: "ISSUE",
                content: {
                  __typename: "Issue",
                  id: "I_kw1",
                  number: 856,
                  title: "Deposit fails",
                  repository: { nameWithOwner: "acme/issues" },
                  assignees: { nodes: [{ login: "alice" }, { login: "bob" }] },
                },
                fieldValues: {
                  nodes: [
                    { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "In Progress", field: { name: "Status" } },
                    { __typename: "ProjectV2ItemFieldIterationValue", title: "Sprint 5", field: { name: "Iteration" } },
                    { __typename: "ProjectV2ItemFieldSingleSelectValue", name: "P1", field: { name: "Priority" } },
                  ],
                },
              },
              {
                id: "PVTI_2",
                type: "DRAFT_ISSUE",
                content: { __typename: "DraftIssue", id: "DI_1", title: "Spike" },
                fieldValues: { nodes: [] },
              },
              // Items the App cannot see come back REDACTED and must be dropped.
              { id: "PVTI_3", type: "REDACTED", content: null, fieldValues: { nodes: [] } },
            ],
          },
        },
      },
    };

    it("maps items, field values and assignees", async () => {
      const graphql = fakeGraphql([{ match: "items(first: $first", respond: () => itemsResponse }]);
      const adapter = new ProjectsV2GraphqlAdapter(graphql as never);

      const page = await adapter.listProjectItems("acme", 1);

      expect(page.items).toHaveLength(2);
      const issue = page.items[0];
      expect(issue.contentType).toBe("Issue");
      expect(issue.issueNumber).toBe(856);
      expect(issue.issueRepository).toBe("acme/issues");
      expect(issue.status).toBe("In Progress");
      expect(issue.iteration).toBe("Sprint 5");
      expect(issue.priority).toBe("P1");
      expect(issue.assignees).toEqual(["alice", "bob"]);

      expect(page.items[1].contentType).toBe("DraftIssue");
      expect(page.hasNext).toBe(true);
      expect(page.endCursor).toBe("CUR_2");
    });

    it("does not return a cursor once the last page is reached", async () => {
      const graphql = fakeGraphql([
        {
          match: "items(first: $first",
          respond: () => ({
            organization: {
              projectV2: {
                items: { pageInfo: { hasNextPage: false, endCursor: "CUR_LAST" }, nodes: [] },
              },
            },
          }),
        },
      ]);

      const adapter = new ProjectsV2GraphqlAdapter(graphql as never);
      const page = await adapter.listProjectItems("acme", 1, "CUR_1");

      // Returning endCursor alongside hasNext=false would make syncBoard's
      // while-loop spin forever.
      expect(page.hasNext).toBe(false);
      expect(page.endCursor).toBeUndefined();
    });

    it("clamps the page size to GitHub's 100-item connection limit", async () => {
      const graphql = fakeGraphql([
        {
          match: "items(first: $first",
          respond: (vars) => {
            expect(vars.first).toBe(100);
            return { organization: { projectV2: { items: { pageInfo: {}, nodes: [] } } } };
          },
        },
      ]);

      const adapter = new ProjectsV2GraphqlAdapter(graphql as never);
      await adapter.listProjectItems("acme", 1, undefined, 500);
      expect(graphql).toHaveBeenCalled();
    });

    it("returns an empty page when the project is missing", async () => {
      const graphql = fakeGraphql([
        { match: "items(first: $first", respond: () => notFoundError() },
      ]);
      const adapter = new ProjectsV2GraphqlAdapter(graphql as never);

      const page = await adapter.listProjectItems("acme", 42);
      expect(page.items).toEqual([]);
      expect(page.hasNext).toBe(false);
    });
  });

  describe("addIssueToProject", () => {
    it("returns the new project item id", async () => {
      const graphql = fakeGraphql([
        {
          match: "addProjectV2ItemById",
          respond: (vars) => {
            expect(vars.projectId).toBe("PVT_1");
            expect(vars.contentId).toBe("I_kw1");
            return { addProjectV2ItemById: { item: { id: "PVTI_new" } } };
          },
        },
      ]);

      const adapter = new ProjectsV2GraphqlAdapter(graphql as never);
      await expect(adapter.addIssueToProject("PVT_1", "I_kw1")).resolves.toBe("PVTI_new");
    });

    it("throws a permission-shaped error when no item comes back", async () => {
      const graphql = fakeGraphql([
        { match: "addProjectV2ItemById", respond: () => ({ addProjectV2ItemById: null }) },
      ]);

      const adapter = new ProjectsV2GraphqlAdapter(graphql as never);
      await expect(adapter.addIssueToProject("PVT_1", "I_kw1")).rejects.toThrow(/Projects.*permission/i);
    });
  });

  describe("updateProjectItemField", () => {
    it.each([
      ["single select", { singleSelectOptionId: "opt_prog" }, { singleSelectOptionId: "opt_prog" }],
      ["iteration", { iterationId: "it_live" }, { iterationId: "it_live" }],
      ["text", "free form", { text: "free form" }],
    ])("maps a %s value onto the ProjectV2FieldValue input", async (_label, input, expected) => {
      const graphql = fakeGraphql([
        {
          match: "updateProjectV2ItemFieldValue",
          respond: (vars) => {
            expect(vars.value).toEqual(expected);
            return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } };
          },
        },
      ]);

      const adapter = new ProjectsV2GraphqlAdapter(graphql as never);
      await adapter.updateProjectItemField("PVT_1", "PVTI_1", "F_status", input as never);
      expect(graphql).toHaveBeenCalledOnce();
    });
  });

  describe("getIssueNodeId", () => {
    it("returns the issue node id", async () => {
      const graphql = fakeGraphql([
        {
          match: "issue(number: $number)",
          respond: () => ({ repository: { issue: { id: "I_kw1" }, pullRequest: null } }),
        },
      ]);

      const adapter = new ProjectsV2GraphqlAdapter(graphql as never);
      await expect(adapter.getIssueNodeId("acme", "issues", 856)).resolves.toBe("I_kw1");
    });

    it("falls back to the pull request when the number is a PR", async () => {
      const graphql = fakeGraphql([
        {
          match: "issue(number: $number)",
          respond: () => ({ repository: { issue: null, pullRequest: { id: "PR_kw2" } } }),
        },
      ]);

      const adapter = new ProjectsV2GraphqlAdapter(graphql as never);
      await expect(adapter.getIssueNodeId("acme", "web", 42)).resolves.toBe("PR_kw2");
    });

    it("recovers a node id from a partial NOT_FOUND response", async () => {
      // Asking for issue+pullRequest guarantees one NOT_FOUND, which GitHub
      // reports as an error alongside usable data.
      const graphql = vi.fn(async () => {
        throw Object.assign(new Error("Could not resolve to an issue"), {
          errors: [{ type: "NOT_FOUND" }],
          data: { repository: { issue: null, pullRequest: { id: "PR_kw2" } } },
        });
      });

      const adapter = new ProjectsV2GraphqlAdapter(graphql as never);
      await expect(adapter.getIssueNodeId("acme", "web", 42)).resolves.toBe("PR_kw2");
    });

    it("throws when neither an issue nor a PR exists", async () => {
      const graphql = fakeGraphql([
        {
          match: "issue(number: $number)",
          respond: () => ({ repository: { issue: null, pullRequest: null } }),
        },
      ]);

      const adapter = new ProjectsV2GraphqlAdapter(graphql as never);
      await expect(adapter.getIssueNodeId("acme", "web", 999)).rejects.toThrow("#999 not found");
    });
  });

  describe("graphqlFromOctokit", () => {
    it("delegates to octokit.graphql", async () => {
      const graphql = vi.fn().mockResolvedValue({ viewer: { login: "app" } });
      const client = graphqlFromOctokit({ graphql } as never);

      await expect(client("query { viewer { login } }", { a: 1 })).resolves.toEqual({
        viewer: { login: "app" },
      });
      expect(graphql).toHaveBeenCalledWith("query { viewer { login } }", { a: 1 });
    });
  });
});
