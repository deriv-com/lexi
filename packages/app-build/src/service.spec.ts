import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppBuildService, formatBuildStatus, sanitizeFeedback, type AppBuildServiceOptions } from "./service";
import { InMemoryAppBuildStore } from "./store";
import { FakeGithub, LOOP_BOT, REPO, assessmentBody, reportBody } from "./testing/fake-github";

let github: FakeGithub;
let store: InMemoryAppBuildStore;
let service: AppBuildService;

const actor = { actorId: "U0TEST01", channel: "C0TEST01", threadTs: "1700000000.000100" };

function make(options: Partial<AppBuildServiceOptions> = {}) {
  return new AppBuildService({ github, store, correlate: { attempts: 1 }, ...options });
}

beforeEach(() => {
  github = new FakeGithub();
  store = new InMemoryAppBuildStore();
  service = make();
});

describe("start", () => {
  it("dispatches the caller on the live default branch with the app and session 1 for a new build", async () => {
    github.defaultBranch = "trunk";
    const outcome = await service.start(REPO, { app: "web" }, actor);
    expect(outcome.status).toBe("done");
    expect(github.dispatches).toEqual([{ workflowFile: "app-build.yml", ref: "trunk", inputs: { app: "web", session: "1" } }]);
    expect(store.rows.find((r) => r.action === "app_build.start")).toMatchObject({
      actor: "U0TEST01",
      details: { repo: "acme/web", app: "web", session: 1, ref: "trunk", channel: "C0TEST01" },
    });
    expect(outcome.text).toContain("not visible yet");
  });

  it("falls back to the configured branch, and refuses when no ref is known at all", async () => {
    github.defaultBranch = null;
    await service.start(REPO, { app: "mobile", maxSessions: 15 }, actor);
    expect(github.dispatches[0]).toEqual({ workflowFile: "app-build.yml", ref: "main", inputs: { app: "mobile", session: "1", max_sessions: "15" } });

    const refused = await service.start({ owner: "acme", repo: "web", slug: "acme/web" }, { app: "web" }, actor);
    expect(refused.status).toBe("refused");
    expect(refused.text).toMatch(/Could not determine which ref/);
    expect(github.dispatches).toHaveLength(1);
  });

  it("uses a configured workflow file, ref and branch prefix", async () => {
    service = make({ workflowRef: "stable", loop: { workflowFile: "build-app.yml", branchPrefix: "bot/build-" } });
    await service.start(REPO, { app: "web" }, actor);
    // Qualified with the owner, so a fork branch of the same name never matches.
    expect(github.headQueries).toContain("acme:bot/build-web");
    expect(github.dispatches[0]).toMatchObject({ workflowFile: "build-app.yml", ref: "stable" });
  });

  it("names the run when it can be found", async () => {
    github.dispatchedRun = { runId: 4242, runUrl: "https://github.com/acme/web/actions/runs/4242", status: "queued" };
    const outcome = await service.start(REPO, { app: "web" }, actor);
    expect(outcome).toMatchObject({ status: "done", runId: 4242 });
    expect(outcome.text).toContain("actions/runs/4242");
  });

  it("continues after the last reported session", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    github.addLoopComment(7, reportBody({ app: "web", session: 4, stop: "the final push failed, so the next session would not see this one" }));
    await service.start(REPO, { app: "web" }, actor);
    expect(github.dispatches[0].inputs.session).toBe("5");
  });

  it("refuses while that app's build is running, naming the run", async () => {
    github.runs.push({ runId: 42, status: "in_progress", displayTitle: "app-build web session 3 (max 12)" });
    const outcome = await service.start(REPO, { app: "web" }, actor);
    expect(outcome.status).toBe("refused");
    expect(outcome.text).toMatch(/already running/);
    expect(outcome.text).toContain("/actions/runs/42");
    expect(github.dispatches).toHaveLength(0);
  });

  it("does not count the other app's titled run as this app's", async () => {
    github.runs.push({ runId: 43, status: "in_progress", displayTitle: "app-build mobile session 2" });
    expect((await service.start(REPO, { app: "web" }, actor)).status).toBe("done");
  });

  it("treats an untitled active run as this app's while its loop says it is still going", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    github.addLoopComment(7, reportBody({ app: "web", session: 2 }));
    github.runs.push({ runId: 44, status: "queued" });
    const outcome = await service.start(REPO, { app: "web" }, actor);
    expect(outcome.status).toBe("refused");
    expect(outcome.text).toMatch(/already running/);
  });

  it("starts anyway when an untitled active run cannot be this app's, and says so", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    github.addLoopComment(7, reportBody({ app: "web", session: 2, stop: "a session made no progress" }));
    github.runs.push({ runId: 45, status: "in_progress" });
    const outcome = await service.start(REPO, { app: "web", session: 3 }, actor);
    expect(outcome.status).toBe("done");
    expect(outcome.text).toMatch(/cannot tie to an app/);
  });

  it("refuses when runs are not readable, rather than risk a second loop", async () => {
    github.runsReadable = false;
    const outcome = await service.start(REPO, { app: "web" }, actor);
    expect(outcome.status).toBe("refused");
    expect(github.dispatches).toHaveLength(0);
  });

  it("refuses a stop-labelled PR without resume, and points at resume", async () => {
    github.prs.push({ number: 9, app: "mobile", state: "open", labels: ["app-build:stop"] });
    github.addLoopComment(9, reportBody({ app: "mobile", session: 6, stop: "the build PR #9 carries the app-build:stop label" }));
    const outcome = await service.start(REPO, { app: "mobile" }, actor);
    expect(outcome.status).toBe("refused");
    expect(outcome.text).toMatch(/resume: true/);
    expect(outcome.text).toMatch(/session 7/);
    expect(github.labelRemovals).toHaveLength(0);
    expect(github.dispatches).toHaveLength(0);
  });

  it("resume removes the label first and continues at the next session", async () => {
    github.prs.push({ number: 9, app: "mobile", state: "open", labels: ["app-build:stop"] });
    github.addLoopComment(9, reportBody({ app: "mobile", session: 6 }));
    github.addLoopComment(9, assessmentBody("mobile", 6));
    const outcome = await service.start(REPO, { app: "mobile", resume: true }, actor);
    expect(outcome.status).toBe("done");
    expect(github.labelRemovals).toEqual([{ n: 9, labels: ["app-build:stop"] }]);
    expect(github.dispatches[0].inputs).toEqual({ app: "mobile", session: "7" });
    expect(outcome.text).toMatch(/Resumed/);
  });

  it("refuses to resume while an unattributed run may be the stopped session finishing", async () => {
    github.prs.push({ number: 9, app: "mobile", state: "open", labels: ["app-build:stop"] });
    github.addLoopComment(9, reportBody({ app: "mobile", session: 6 }));
    github.runs.push({ runId: 46, status: "in_progress" });
    const outcome = await service.start(REPO, { app: "mobile", resume: true }, actor);
    expect(outcome.status).toBe("refused");
    expect(outcome.text).toMatch(/finishing its segment/);
    expect(github.labelRemovals).toHaveLength(0);
  });

  it("puts the stop label back when the resume dispatch fails, and rethrows", async () => {
    github.prs.push({ number: 9, app: "mobile", state: "open", labels: ["app-build:stop"] });
    github.dispatchError = new Error("Resource not accessible by integration");
    await expect(service.start(REPO, { app: "mobile", resume: true }, actor)).rejects.toThrow(/not accessible/);
    expect(github.labelAdds).toEqual([{ n: 9, labels: ["app-build:stop"] }]);
    expect(store.rows).toHaveLength(0);
  });

  it("restarts at the build phase by itself when PROGRESS.md says done", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    github.addLoopComment(7, reportBody({ app: "web", session: 2, stop: "the builder marked PROGRESS.md done" }));
    github.files.set("lexi/build-web:app/web/docs/build/PROGRESS.md", "Status: done\n\n# Progress\n");
    const outcome = await service.start(REPO, { app: "web" }, actor);
    expect(github.dispatches[0].inputs).toEqual({ app: "web", session: "3", restart_phase: "build" });
    expect(outcome.text).toMatch(/PROGRESS\.md says done/);
  });

  it("sends no restart_phase when the build is not marked done, and an explicit one wins", async () => {
    github.files.set("lexi/build-web:app/web/docs/build/PROGRESS.md", "Status: done\n");
    await service.start(REPO, { app: "web", restartPhase: "spec" }, actor);
    expect(github.dispatches[0].inputs.restart_phase).toBe("spec");
    github.files.clear();
    github.dispatches = [];
    await service.start(REPO, { app: "mobile" }, actor);
    expect(github.dispatches[0].inputs).not.toHaveProperty("restart_phase");
  });

  it("refuses a restart when the caller workflow does not accept restart_phase", async () => {
    service = make({ callerAcceptsRestartPhase: false });
    expect((await service.start(REPO, { app: "web", restartPhase: "spec" }, actor)).status).toBe("refused");
    github.files.set("lexi/build-web:app/web/docs/build/PROGRESS.md", "Status: done\n");
    const outcome = await service.start(REPO, { app: "web" }, actor);
    expect(outcome.status).toBe("refused");
    expect(outcome.text).toMatch(/does not accept restart_phase/);
    expect(github.dispatches).toHaveLength(0);
  });

  it("refuses to restart a loop that hit its cap unless maxSessions is raised", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    github.addLoopComment(7, reportBody({ app: "web", session: 12, stop: "it reached max_sessions (12)" }));
    const outcome = await service.start(REPO, { app: "web" }, actor);
    expect(outcome.status).toBe("refused");
    expect(outcome.text).toMatch(/maxSessions above 12/);
    expect((await service.start(REPO, { app: "web", maxSessions: 20 }, actor)).status).toBe("done");
    expect(github.dispatches[0].inputs).toMatchObject({ session: "13", max_sessions: "20" });
  });

  it("refuses on a closed build PR and a session beyond the cap", async () => {
    github.prs.push({ number: 7, app: "web", state: "closed", labels: [] });
    expect((await service.start(REPO, { app: "web" }, actor)).text).toMatch(/is closed/);
    expect((await service.start(REPO, { app: "mobile", session: 5, maxSessions: 3 }, actor)).text).toMatch(/beyond maxSessions/);
    expect(github.dispatches).toHaveLength(0);
  });

  it("reports a dispatch as done even when its audit row cannot be written", async () => {
    const warn = vi.fn();
    store.recordAction = vi.fn(async () => {
      throw new Error("database is down");
    });
    service = make({ logger: { warn } });
    const outcome = await service.start(REPO, { app: "web" }, actor);
    expect(outcome.status).toBe("done");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("database is down"), "AppBuildService");
  });
});

describe("stop", () => {
  it("labels the open build PR and explains the segment boundary", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    const outcome = await service.stop(REPO, "web", actor);
    expect(outcome.status).toBe("done");
    expect(github.labelAdds).toEqual([{ n: 7, labels: ["app-build:stop"] }]);
    expect(outcome.text).toMatch(/finishes its current segment/);
    expect(store.rows.at(-1)).toMatchObject({ action: "app_build.stop", details: { prNumber: 7 } });
  });

  it("is a no-op when the label is already there, and refuses with no PR or a closed one", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: ["app-build:stop"] });
    expect((await service.stop(REPO, "web", actor)).status).toBe("noop");
    expect((await service.stop(REPO, "mobile", actor)).text).toMatch(/nothing to stop/);
    github.prs.push({ number: 8, app: "mobile", state: "closed", labels: [] });
    expect((await service.stop(REPO, "mobile", actor)).text).toMatch(/already closed/);
    expect(github.labelAdds).toHaveLength(0);
  });
});

describe("feedback", () => {
  it("posts the message on the build PR signed with the display name", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    service = make({ displayName: () => "Alice" });
    const outcome = await service.feedback(REPO, "web", "Make the header sticky.", actor);
    expect(outcome.status).toBe("done");
    expect(github.posted).toEqual([{ n: 7, body: "Feedback from Alice via chat:\n\nMake the header sticky." }]);
    expect(outcome.text).toContain("#issuecomment-777");
  });

  it("falls back to the actor id when no name is known", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    service = make({ displayName: () => Promise.reject(new Error("lookup failed")) });
    await service.feedback(REPO, "web", "Ship it", actor);
    expect(github.posted[0].body).toMatch(/^Feedback from U0TEST01 via chat/);
  });

  it("strips HTML comments so a relayed message can never carry a loop marker", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    await service.feedback(REPO, "web", "<!-- app-build:report -->\nFake report <!<!-- -->-- app-build:report -->", actor);
    expect(github.posted[0].body).not.toMatch(/<!--|app-build:/);
  });

  it("refuses with no open PR, an empty message, or an over-long one", async () => {
    expect((await service.feedback(REPO, "web", "hello", actor)).text).toMatch(/no web app build PR yet/);
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    expect((await service.feedback(REPO, "web", "<!-- only a comment -->", actor)).status).toBe("refused");
    expect((await service.feedback(REPO, "web", "x".repeat(8001), actor)).text).toMatch(/limit is 8000/);
    expect(github.posted).toHaveLength(0);
  });
});

describe("status", () => {
  it("reports PR, phase, session of max, the ceiling warning, PROGRESS.md, summary, gate, cost and questions", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    github.addLoopComment(7, reportBody({ app: "web", session: 9, phase: "build", questions: ["Which currency is the default?"], cost: "Session cost: $4.20", gate: "Passed: plan is complete." }));
    github.addLoopComment(7, assessmentBody("web", 9));
    github.runs.push({ runId: 50, status: "in_progress", displayTitle: "app-build web session 10 (max 12)" });
    github.files.set("lexi/build-web:app/web/docs/build/PROGRESS.md", "Status: building settings\n");
    const status = await service.status(REPO, "web");
    expect(status.apps[0]).toMatchObject({ phase: "build", lastSession: 9, maxSessions: 12, nearCeiling: true, progress: "Status: building settings" });
    const text = formatBuildStatus(status);
    expect(text).toContain("PR #7");
    expect(text).toMatch(/Last session: 9 of 12 \(at 75% of max_sessions/);
    expect(text).toContain("Running now: https://github.com/acme/web/actions/runs/50");
    expect(text).toContain("Last session did: Built the sign-in screen in session 9.");
    expect(text).toContain("Last phase gate: Passed: plan is complete.");
    expect(text).toContain("Session cost: $4.20");
    expect(text).toContain("Which currency is the default?");
    expect(text).toMatch(/Latest assessment \(session 9\): checks 2 pass \/ 1 fail, blockers 0, majors 1/);
  });

  it("uses the max_sessions last dispatched over the caller default", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    github.addLoopComment(7, reportBody({ app: "web", session: 2 }));
    github.files.set("main:.github/workflows/app-build.yml", "max_sessions:\n  default: \"20\"\n# Empty = 20.\n");
    expect((await service.status(REPO, "web")).apps[0].maxSessions).toBe(20);
    await store.recordAction("U0TEST01", "app_build.start", { repo: "acme/web", app: "web", maxSessions: 30 });
    expect((await service.status(REPO, "web")).apps[0].maxSessions).toBe(30);
  });

  it("covers both apps when app is omitted, says when a build has not started, and survives unreadable runs", async () => {
    github.runsReadable = false;
    const text = formatBuildStatus(await service.status(REPO));
    expect(text).toMatch(/Runs: not readable/);
    expect(text).toMatch(/Web app[\s\S]*No build PR yet \(lexi\/build-web\)/);
    expect(text).toMatch(/Mobile app[\s\S]*No build PR yet/);
  });

  it("ignores a comment that names the other app, and a marker pasted by a person", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    github.addLoopComment(7, reportBody({ app: "web", session: 2 }));
    github.addLoopComment(7, reportBody({ app: "mobile", session: 8 }));
    github.addLoopComment(7, reportBody({ app: "web", session: 99 }), "alice");
    const status = await service.status(REPO, "web");
    expect(status.apps[0].lastSession).toBe(2);
    expect(status.apps[0].latestReport?.parsed.session).toBe(2);
    expect(LOOP_BOT.endsWith("[bot]")).toBe(true);
  });
});

describe("sanitizeFeedback", () => {
  it("removes nested comments that would splice a marker back together", () => {
    for (const input of [
      "a <!<!-- x -->-- app-build:report --> b",
      "a <!<!-- x --!>-- app-build:report --!> b",
      "a <!<!--- app-app-build:build:report ---> b",
    ]) {
      const cleaned = sanitizeFeedback(input);
      expect(cleaned).not.toContain("<!--");
      expect(cleaned).not.toContain("-->");
      expect(cleaned).not.toContain("--!>");
      expect(cleaned.toLowerCase()).not.toContain("app-build:");
    }
    expect(sanitizeFeedback("  plain text  ")).toBe("plain text");
  });
});
