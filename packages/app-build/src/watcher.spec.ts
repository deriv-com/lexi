import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppBuildReader } from "./reader";
import { InMemoryAppBuildStore } from "./store";
import { AppBuildWatcher, reportText, type AppBuildChatPort } from "./watcher";
import { FakeGithub, REPO, assessmentBody, reportBody } from "./testing/fake-github";

class FakeChat implements AppBuildChatPort {
  posts: Array<{ channel: string; threadTs?: string; text: string }> = [];
  refuseNext = 0;
  private ts = 100;
  async sendMessage(payload: { channel: string; text: string; threadTs?: string }) {
    if (this.refuseNext > 0) {
      this.refuseNext -= 1;
      return { ok: false, error: "ratelimited" };
    }
    this.posts.push(payload);
    return { ok: true, ts: `${this.ts++}.000` };
  }
}

let github: FakeGithub;
let store: InMemoryAppBuildStore;
let chat: FakeChat;

function watcher(channel = "C0TEST01") {
  return new AppBuildWatcher({ reader: new AppBuildReader(github, store), store, chat, targets: [{ target: REPO, channel }] });
}

beforeEach(() => {
  github = new FakeGithub();
  store = new InMemoryAppBuildStore();
  chat = new FakeChat();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AppBuildWatcher", () => {
  it("does nothing without a build PR, and is inert with no channel", async () => {
    expect(await watcher().tick()).toMatchObject({ apps: 2, threadsCreated: 0, relayed: 0 });
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    expect(await watcher("  ").tick()).toMatchObject({ apps: 0 });
    expect(chat.posts).toHaveLength(0);
  });

  it("creates one parent per build PR on first sight, then relays new reports as thread replies", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    github.addLoopComment(7, reportBody({ app: "web", session: 1 }));
    const w = watcher();
    expect(await w.tick()).toMatchObject({ threadsCreated: 1, relayed: 1 });
    expect(chat.posts[0].channel).toBe("C0TEST01");
    expect(chat.posts[0].threadTs).toBeUndefined();
    expect(chat.posts[0].text).toContain("PR #7");
    expect(chat.posts[1]).toMatchObject({ threadTs: "100.000" });
    expect(chat.posts[1].text).toMatch(/\*Session 1\*/);

    github.addLoopComment(7, reportBody({ app: "web", session: 2 }));
    github.addLoopComment(7, assessmentBody("web", 2));
    expect(await w.tick()).toMatchObject({ threadsCreated: 0, relayed: 2 });
    expect(chat.posts.slice(2).map((p) => p.threadTs)).toEqual(["100.000", "100.000"]);
    expect(chat.posts[3].text).toMatch(/Assessment of session 2.*1 major/);
  });

  it("never relays the same comment twice, across ticks and a fresh watcher on the same store", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    github.addLoopComment(7, reportBody({ app: "web", session: 1 }));
    await watcher().tick();
    await watcher().tick();
    expect(chat.posts).toHaveLength(2);
  });

  it("on first sight relays only the newest report and assessment, not the whole history", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    for (let s = 1; s <= 4; s += 1) github.addLoopComment(7, reportBody({ app: "web", session: s }));
    github.addLoopComment(7, assessmentBody("web", 4));
    await watcher().tick();
    expect(chat.posts).toHaveLength(3);
    expect(chat.posts[1].text).toMatch(/Session 4/);
  });

  it("retries a relay the chat refused, without replaying the history", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    github.addLoopComment(7, reportBody({ app: "web", session: 1 }));
    const w = watcher();
    await w.tick();
    github.addLoopComment(7, reportBody({ app: "web", session: 2 }));
    chat.refuseNext = 1;
    expect(await w.tick()).toMatchObject({ relayed: 0, errors: 1 });
    expect(await w.tick()).toMatchObject({ relayed: 1, errors: 0 });
    expect(chat.posts.map((p) => p.text).filter((t) => /Session 2/.test(t))).toHaveLength(1);
  });

  it("warns once when a session reaches the share of max_sessions", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    github.runs.push({ runId: 1, status: "completed", displayTitle: "app-build web session 9 (max 12)" });
    github.addLoopComment(7, reportBody({ app: "web", session: 9 }));
    const w = watcher();
    await w.tick();
    github.addLoopComment(7, reportBody({ app: "web", session: 10 }));
    await w.tick();
    const warnings = chat.posts.filter((p) => /Heads up/.test(p.text));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].text).toMatch(/9 of 12 sessions \(75%/);
  });

  it("leads with the stop reason when the loop stops, and notes a closed PR once", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] });
    github.addLoopComment(7, reportBody({ app: "web", session: 4, stop: "the build PR #7 carries the app-build:stop label" }));
    const w = watcher();
    await w.tick();
    expect(chat.posts[1].text.split("\n")[0]).toMatch(/build loop stopped\* after session 4: the build PR #7 carries the app-build:stop label/);
    github.prs[0].state = "closed";
    await w.tick();
    await w.tick();
    expect(chat.posts.filter((p) => /was closed/.test(p.text))).toHaveLength(1);
  });

  it("ignores a PR that was already closed before it was ever seen", async () => {
    github.prs.push({ number: 7, app: "web", state: "closed", labels: [] });
    github.addLoopComment(7, reportBody({ app: "web", session: 1 }));
    await watcher().tick();
    expect(chat.posts).toHaveLength(0);
  });

  it("keeps the two apps' threads apart, and ignores a marker pasted by a person", async () => {
    github.prs.push({ number: 7, app: "web", state: "open", labels: [] }, { number: 8, app: "mobile", state: "open", labels: [] });
    github.addLoopComment(7, reportBody({ app: "web", session: 1 }));
    github.addLoopComment(8, reportBody({ app: "mobile", session: 3 }));
    github.addLoopComment(8, reportBody({ app: "mobile", session: 99 }), "alice");
    await watcher().tick();
    const parents = chat.posts.filter((p) => p.threadTs === undefined);
    expect(parents).toHaveLength(2);
    expect(chat.posts.some((p) => /Session 99/.test(p.text))).toBe(false);
  });

  it("escapes report text and keeps lines bounded", () => {
    const text = reportText(
      "web",
      {
        id: 1,
        createdAt: "",
        url: "https://github.com/acme/web/pull/7#issuecomment-1",
        parsed: {
          kind: "report", app: "web", session: 2, phase: "build", runUrl: null, summary: "<script>&" + "x".repeat(2000),
          questions: [], cost: null, gateVerdict: null, checks: { pass: 0, fail: 0, missing: 0 }, stopReason: null, continuing: true,
        },
      },
      null,
    );
    expect(text).toContain("&lt;script&gt;&amp;");
    expect(text.split("\n").every((line) => line.length <= 520)).toBe(true);
  });

  it("starts and stops a timer that ticks, without overlapping ticks", async () => {
    vi.useFakeTimers();
    const w = new AppBuildWatcher({ reader: new AppBuildReader(github, store), store, chat, targets: [{ target: REPO, channel: "C0TEST01" }], intervalMs: 1000 });
    const spy = vi.spyOn(w, "tick");
    w.start();
    w.start();
    await vi.advanceTimersByTimeAsync(2500);
    expect(spy).toHaveBeenCalledTimes(2);
    await w.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
