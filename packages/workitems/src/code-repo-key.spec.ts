import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadRepoRegistry } from "./repo-registry";
import {
  CODE_REPO_KEY_STATUS,
  codeRepoKeyFor,
  codeRepoKeyMetadata,
  describeUnresolvedCodeRepo,
  resolveCodeRepoKey,
} from "./code-repo-key";

/**
 * `WorkItem.codeRepoKey` is documented as "repos.yaml key with role=code". The
 * dispatch point only ever holds an `organization/repository`, which is a
 * different identifier — so the column stayed null rather than being filled
 * with a wrong-shaped value.
 *
 * The fix is a resolution, not a string transform: the registry already knows
 * which key owns which slug and which roles that key holds. These tests pin
 * the three outcomes that resolution can have, and that only one of them may
 * ever reach the column.
 */

const CONFIG_DIR = resolve(__dirname, "../../../examples/config");
const registry = loadRepoRegistry(CONFIG_DIR);

describe("resolveCodeRepoKey", () => {
  it("resolves a registered code repo's slug to its repos.yaml key", () => {
    const result = resolveCodeRepoKey(registry, "acme/web-app");

    expect(result).toEqual({
      status: CODE_REPO_KEY_STATUS.RESOLVED,
      key: "home_web",
      slug: "acme/web-app",
    });
  });

  it("resolves the mobile code repo too — the key is read, never derived", () => {
    const result = resolveCodeRepoKey(registry, "acme/mobile-app");

    expect(result).toMatchObject({
      status: CODE_REPO_KEY_STATUS.RESOLVED,
      key: "home_mobile",
    });
  });

  /**
   * The constraint the column documents, enforced rather than restated.
   * `issues` is registered and resolvable — it simply holds
   * `roles: [issues]`. Writing its key into a `role=code` column would be a
   * documented-contract violation that no reader could detect afterwards.
   */
  it("refuses a repo that resolves but does not hold the code role", () => {
    const result = resolveCodeRepoKey(registry, "acme/issues");

    expect(result).toEqual({
      status: CODE_REPO_KEY_STATUS.NOT_A_CODE_REPO,
      key: "issues",
      slug: "acme/issues",
    });
  });

  /** No key is invented, and the slug is carried so the gap is diagnosable. */
  it("reports an unregistered slug rather than guessing a key from it", () => {
    const result = resolveCodeRepoKey(registry, "acme/not-in-the-registry");

    expect(result).toEqual({
      status: CODE_REPO_KEY_STATUS.UNREGISTERED,
      slug: "acme/not-in-the-registry",
    });
    expect(result).not.toHaveProperty("key");
  });

  it("does not transform the slug into a key by string munging", () => {
    // "acme/web-app" -> "home_web" is a registry fact, not a derivation:
    // no case/separator rewrite of the slug produces it. A hand-rolled mapping
    // would necessarily disagree with repos.yaml the moment either changed.
    const result = resolveCodeRepoKey(registry, "acme/web-app");
    expect(result.status === CODE_REPO_KEY_STATUS.RESOLVED && result.key).toBe("home_web");
    expect("acme/web-app").not.toContain("home_web");
  });

  it("treats a blank slug as unregistered rather than throwing", () => {
    expect(resolveCodeRepoKey(registry, "").status).toBe(CODE_REPO_KEY_STATUS.UNREGISTERED);
  });
});

describe("codeRepoKeyMetadata", () => {
  it("records the resolved key and its status", () => {
    expect(codeRepoKeyMetadata(resolveCodeRepoKey(registry, "acme/web-app"))).toEqual({
      codeRepoKeyStatus: CODE_REPO_KEY_STATUS.RESOLVED,
      codeRepoSlug: "acme/web-app",
    });
  });

  /**
   * An unresolved repo is a config gap someone must close. The status is
   * written to `WorkItem.metadata` so the gap is queryable — silence is how a
   * missing registry entry stays missing.
   */
  it("records an unregistered slug as a queryable status, never as silence", () => {
    const metadata = codeRepoKeyMetadata(resolveCodeRepoKey(registry, "acme/nope"));

    expect(metadata).toEqual({
      codeRepoKeyStatus: CODE_REPO_KEY_STATUS.UNREGISTERED,
      codeRepoSlug: "acme/nope",
    });
  });

  /**
   * The offending key IS carried in metadata for the non-code case — that is
   * the entry whose `roles` need fixing. It is diagnostic data in a free-form
   * blob, which is a different thing from the documented column.
   */
  it("names the mis-roled key in metadata so the config entry can be fixed", () => {
    const metadata = codeRepoKeyMetadata(
      resolveCodeRepoKey(registry, "acme/issues"),
    );

    expect(metadata).toEqual({
      codeRepoKeyStatus: CODE_REPO_KEY_STATUS.NOT_A_CODE_REPO,
      codeRepoSlug: "acme/issues",
      codeRepoKeyRejected: "issues",
    });
  });
});

/**
 * A slug that names two apps.
 *
 * A repository holding two apps is two `repos.yaml` keys differing only by `workdir`. A slug
 * cannot pick between them — so the resolution reports the plurality rather than taking
 * the first match, which is the same discipline the three original statuses
 * exist to enforce: never a wrong-but-plausible key.
 */
describe("resolveCodeRepoKey — a slug registered under several keys", () => {
  const AMBIGUOUS_SLUG = "acme-labs/web-app-next";
  const dir = mkdtempSync(join(tmpdir(), "code-repo-key-"));
  writeFileSync(
    join(dir, "repos.yaml"),
    `
version: 1
source:
  issues:
    organization: acme-internal
    repository: issues
    roles: [issues]
products:
  home_web:
    organization: acme
    repository: web-app
    platform: web
    roles: [code, specs, issues]
  home_web_ai:
    organization: acme-labs
    repository: web-app-next
    workdir: app/web
    platform: web_ai
    roles: [code, specs, issues]
  home_mobile_ai:
    organization: acme-labs
    repository: web-app-next
    workdir: app/mobile
    platform: mobile_ai
    roles: [code, specs, issues]
    placeholder: true
`,
    "utf8",
  );
  const registry = loadRepoRegistry(dir);

  it("reports AMBIGUOUS with every candidate rather than the first match", () => {
    const resolution = resolveCodeRepoKey(registry, AMBIGUOUS_SLUG);
    expect(resolution.status).toBe(CODE_REPO_KEY_STATUS.AMBIGUOUS);
    if (resolution.status !== CODE_REPO_KEY_STATUS.AMBIGUOUS) throw new Error("unreachable");
    expect(resolution.keys).toEqual(["home_web_ai", "home_mobile_ai"]);
    expect(resolution.slug).toBe(AMBIGUOUS_SLUG);
  });

  it("writes NO key to the column", () => {
    // The whole contract of this module: only RESOLVED reaches the column.
    // A mobile task filed under home_web_ai would look correctly tracked to
    // everyone reading it, which is worse than a null.
    expect(codeRepoKeyFor(resolveCodeRepoKey(registry, AMBIGUOUS_SLUG))).toBeNull();
  });

  it("records both candidates in metadata so the gap is queryable", () => {
    expect(codeRepoKeyMetadata(resolveCodeRepoKey(registry, AMBIGUOUS_SLUG))).toEqual({
      codeRepoKeyStatus: CODE_REPO_KEY_STATUS.AMBIGUOUS,
      codeRepoSlug: AMBIGUOUS_SLUG,
      codeRepoKeyRejected: "home_web_ai, home_mobile_ai",
    });
  });

  it("names the actual fix, which is not the fix for the other statuses", () => {
    const sentence = describeUnresolvedCodeRepo(resolveCodeRepoKey(registry, AMBIGUOUS_SLUG));
    expect(sentence).toContain("2 keys");
    expect(sentence).toContain("home_web_ai, home_mobile_ai");
    // "add the repo" and "add the role" are the WRONG advice here; the entry
    // exists twice and both hold `code`. The fix is upstream, at the caller.
    expect(sentence).toContain("must carry the repo key");
    expect(sentence).not.toContain("add ");
  });

  it("still resolves the singly-registered production repo cleanly", () => {
    // Different org, so a different slug — the rebuild entries must not make
    // the repo Lexi actually triages bugs in ambiguous.
    const resolution = resolveCodeRepoKey(registry, "acme/web-app");
    expect(resolution.status).toBe(CODE_REPO_KEY_STATUS.RESOLVED);
    expect(codeRepoKeyFor(resolution)).toBe("home_web");
  });
});
