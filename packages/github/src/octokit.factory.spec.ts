import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Every GitHub interaction is mocked: this suite must never make a network
 * call. `Octokit` is replaced with a recording stub and `createAppAuth` with a
 * sentinel, so we can assert on the constructor args (auth strategy, appId,
 * normalised PEM, installation id) and on which app-level endpoints were hit.
 */

interface Recorded {
  options: Record<string, any>;
  request: ReturnType<typeof vi.fn>;
}

type RequestImpl = (route: string, params?: Record<string, unknown>) => Promise<{ data: unknown }>;

// Hoisted so the vi.mock factories (which run before module initialisers) can
// close over this shared state.
const h = vi.hoisted(() => ({
  constructed: [] as any[],
  requestImpl: (async () => ({ data: undefined })) as RequestImpl,
  appAuthSentinel: function createAppAuthSentinel() {
    /* never invoked — Octokit itself is stubbed */
  },
}));

const constructed = h.constructed as Recorded[];
const APP_AUTH_SENTINEL = h.appAuthSentinel;
function setRequestImpl(impl: RequestImpl): void {
  h.requestImpl = impl;
}

vi.mock("@octokit/rest", () => ({
  Octokit: class {
    request: ReturnType<typeof vi.fn>;
    constructor(public options: Record<string, any> = {}) {
      this.request = vi.fn((route: string, params?: Record<string, unknown>) => h.requestImpl(route, params));
      h.constructed.push({ options, request: this.request });
    }
  },
}));

vi.mock("@octokit/auth-app", () => ({ createAppAuth: h.appAuthSentinel }));

import { createOctokitClient, isUserPatForEvidenceHtml, normalizePrivateKey, resolveAuthMode } from "./octokit.factory";

// PEM markers are built from parts so this fake key does not trip the repository's secret scan.
const BEGIN = "-----BEGIN RSA " + "PRIVATE KEY-----";
const END = "-----END RSA " + "PRIVATE KEY-----";
const PEM_BODY = "MIIEowIBAAKCAQEAfake";
const ESCAPED_PEM = `${BEGIN}\\n${PEM_BODY}\\n${END}`;
const REAL_PEM = `${BEGIN}\n${PEM_BODY}\n${END}\n`;

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn() };
}

function allRequestedRoutes(): string[] {
  return constructed.flatMap((c) => c.request.mock.calls.map((call) => String(call[0])));
}

beforeEach(() => {
  constructed.length = 0;
  setRequestImpl(async (route) => {
    if (route === "GET /repos/{owner}/{repo}/installation") return { data: { id: 4242 } };
    if (route === "GET /app/installations") {
      return { data: [{ id: 9001, account: { login: "acme-internal" } }] };
    }
    throw new Error(`unexpected route ${route}`);
  });
});

describe("resolveAuthMode", () => {
  it("selects app mode when both appId and privateKey are present", () => {
    expect(resolveAuthMode({ appId: "123", privateKey: ESCAPED_PEM, token: "ghp_x" })).toBe("app");
  });

  it("falls back to token mode when either App var is missing or blank", () => {
    expect(resolveAuthMode({ token: "ghp_x" })).toBe("token");
    expect(resolveAuthMode({ appId: "123", token: "ghp_x" })).toBe("token");
    expect(resolveAuthMode({ privateKey: ESCAPED_PEM, token: "ghp_x" })).toBe("token");
    expect(resolveAuthMode({ appId: "  ", privateKey: "  ", token: "ghp_x" })).toBe("token");
  });
});

describe("normalizePrivateKey", () => {
  it("converts literal \\n escape sequences into real newlines", () => {
    expect(normalizePrivateKey(ESCAPED_PEM)).toBe(REAL_PEM);
  });

  it("leaves an already multi-line PEM intact", () => {
    expect(normalizePrivateKey(REAL_PEM)).toBe(REAL_PEM);
  });

  it("strips wrapping quotes and normalises CRLF variants", () => {
    expect(normalizePrivateKey(`"${ESCAPED_PEM}"`)).toBe(REAL_PEM);
    expect(normalizePrivateKey(ESCAPED_PEM.replace(/\\n/g, "\\r\\n"))).toBe(REAL_PEM);
    expect(normalizePrivateKey(`  ${ESCAPED_PEM}  `)).toBe(REAL_PEM);
  });

  it("always ends with exactly one trailing newline", () => {
    expect(normalizePrivateKey(`${ESCAPED_PEM}\\n\\n`)).toBe(REAL_PEM);
  });
});

describe("createOctokitClient — PAT fallback", () => {
  it("uses plain token auth and makes no App API calls", async () => {
    const logger = makeLogger();
    await createOctokitClient({ token: "ghp_secret", logger });

    expect(constructed).toHaveLength(1);
    expect(constructed[0].options.auth).toBe("ghp_secret");
    expect(constructed[0].options.authStrategy).toBeUndefined();
    expect(allRequestedRoutes()).toEqual([]);
  });

  it("logs the selected mode without leaking the token", async () => {
    const logger = makeLogger();
    await createOctokitClient({ token: "ghp_secret", logger });

    const logged = [...logger.warn.mock.calls, ...logger.log.mock.calls].flat().join(" ");
    expect(logged).toMatch(/auth mode: token/);
    expect(logged).not.toContain("ghp_secret");
  });

  it("passes baseUrl through and drops an empty one", async () => {
    await createOctokitClient({ token: "t", baseUrl: "https://ghe.example.com/api/v3" });
    expect(constructed[0].options.baseUrl).toBe("https://ghe.example.com/api/v3");

    constructed.length = 0;
    await createOctokitClient({ token: "t", baseUrl: "" });
    expect(constructed[0].options.baseUrl).toBeUndefined();
  });

  it("throws when neither App credentials nor a token are configured", async () => {
    await expect(createOctokitClient({})).rejects.toThrow(/GITHUB_APP_ID|GITHUB_TOKEN/);
  });
});

describe("createOctokitClient — App mode", () => {
  it("resolves the installation id from the repo endpoint and returns an installation client", async () => {
    const logger = makeLogger();
    await createOctokitClient({
      token: "ghp_secret",
      appId: "1234567",
      privateKey: ESCAPED_PEM,
      owner: "acme-internal",
      repo: "issues",
      logger,
    });

    // 1st client = app JWT (lookup), 2nd = installation-scoped.
    expect(constructed).toHaveLength(2);
    expect(constructed[0].options.auth).toEqual({ appId: "1234567", privateKey: REAL_PEM });
    expect(constructed[0].request).toHaveBeenCalledWith("GET /repos/{owner}/{repo}/installation", {
      owner: "acme-internal",
      repo: "issues",
    });

    const installationClient = constructed[1];
    expect(installationClient.options.authStrategy).toBe(APP_AUTH_SENTINEL);
    expect(installationClient.options.auth).toEqual({
      appId: "1234567",
      privateKey: REAL_PEM,
      installationId: 4242,
    });
    // The PAT must not be used once App auth is selected.
    expect(JSON.stringify(installationClient.options)).not.toContain("ghp_secret");
  });

  it("normalises the PEM before handing it to auth-app", async () => {
    await createOctokitClient({ appId: "1", privateKey: ESCAPED_PEM, owner: "o", repo: "r" });
    expect(constructed.at(-1)!.options.auth.privateKey).toBe(REAL_PEM);
    expect(constructed.at(-1)!.options.auth.privateKey).not.toContain("\\n");
  });

  it("logs app mode with ids but never the PEM", async () => {
    const logger = makeLogger();
    await createOctokitClient({ appId: "1234567", privateKey: ESCAPED_PEM, owner: "o", repo: "r", logger });

    const logged = [...logger.log.mock.calls, ...logger.warn.mock.calls].flat().join(" ");
    expect(logged).toMatch(/auth mode: app/);
    expect(logged).toContain("1234567");
    expect(logged).not.toContain(PEM_BODY);
    expect(logged).not.toContain("PRIVATE KEY");
  });

  it("falls back to GET /app/installations when the repo endpoint 404s", async () => {
    setRequestImpl(async (route) => {
      if (route === "GET /repos/{owner}/{repo}/installation") {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }
      if (route === "GET /app/installations") {
        return { data: [{ id: 5555, account: { login: "someone-else" } }, { id: 7777, account: { login: "Acme-Internal" } }] };
      }
      throw new Error(`unexpected route ${route}`);
    });

    await createOctokitClient({ appId: "1", privateKey: ESCAPED_PEM, owner: "acme-internal", repo: "gone" });

    expect(allRequestedRoutes()).toEqual([
      "GET /repos/{owner}/{repo}/installation",
      "GET /app/installations",
    ]);
    // Prefers the installation whose account matches GITHUB_OWNER, case-insensitively.
    expect(constructed.at(-1)!.options.auth.installationId).toBe(7777);
  });

  it("surfaces non-404 lookup failures instead of guessing an installation", async () => {
    setRequestImpl(async () => {
      throw Object.assign(new Error("Bad credentials"), { status: 401 });
    });

    await expect(
      createOctokitClient({ appId: "1", privateKey: ESCAPED_PEM, owner: "o", repo: "r" }),
    ).rejects.toThrow(/Bad credentials/);
  });

  it("throws a directive error when the App has no installations", async () => {
    setRequestImpl(async (route) => {
      if (route === "GET /repos/{owner}/{repo}/installation") {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      }
      return { data: [] };
    });

    await expect(
      createOctokitClient({ appId: "1", privateKey: ESCAPED_PEM, owner: "o", repo: "r" }),
    ).rejects.toThrow(/no installations/);
  });
});

describe("createOctokitClient — installation id short-circuit", () => {
  it("skips the lookup entirely when GITHUB_APP_INSTALLATION_ID is set", async () => {
    const logger = makeLogger();
    await createOctokitClient({
      appId: "1234567",
      privateKey: ESCAPED_PEM,
      installationId: "88888888",
      owner: "acme-internal",
      repo: "issues",
      logger,
    });

    // Only the installation-scoped client is built; no app-JWT client, no requests.
    expect(constructed).toHaveLength(1);
    expect(allRequestedRoutes()).toEqual([]);
    expect(constructed[0].options.auth).toEqual({
      appId: "1234567",
      privateKey: REAL_PEM,
      installationId: 88888888,
    });
    expect(logger.log.mock.calls.flat().join(" ")).toMatch(/resolved via config/);
  });

  it("still resolves at runtime when the pin is blank", async () => {
    await createOctokitClient({
      appId: "1",
      privateKey: ESCAPED_PEM,
      installationId: "   ",
      owner: "acme-internal",
      repo: "issues",
    });

    expect(allRequestedRoutes()).toEqual(["GET /repos/{owner}/{repo}/installation"]);
    expect(constructed.at(-1)!.options.auth.installationId).toBe(4242);
  });

  it("rejects a non-numeric pinned installation id", async () => {
    await expect(
      createOctokitClient({ appId: "1", privateKey: ESCAPED_PEM, installationId: "not-a-number" }),
    ).rejects.toThrow(/GITHUB_APP_INSTALLATION_ID must be numeric/);
  });
});

describe("createOctokitClient — App auth failure degrades instead of crashing", () => {
  it("falls back to the PAT when the private key is not a usable PEM", async () => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const client = await createOctokitClient({
      appId: "1234567",
      privateKey: "not-a-pem-at-all",
      token: "ghp_fallback",
      owner: "acme-internal",
      repo: "issues",
      logger,
    });
    expect(client).toBeDefined();
    expect(logger.error).toHaveBeenCalledOnce();
    const message = String(logger.error.mock.calls[0][0]);
    expect(message).toContain("falling back to the personal access token");
    expect(message).toContain("GITHUB_APP_PRIVATE_KEY");
    // The reason must never leak the key material itself.
    expect(message).not.toContain("not-a-pem-at-all");
  });

  it("throws when App auth fails and there is no PAT to fall back to", async () => {
    await expect(
      createOctokitClient({
        appId: "1234567",
        privateKey: "not-a-pem-at-all",
        token: "",
        owner: "acme-internal",
        repo: "issues",
      }),
    ).rejects.toThrow(/no GITHUB_TOKEN is set to fall back to/);
  });

  it("collapses double-escaped newlines in the PEM", () => {
    const pem = `${BEGIN}\\\\nBODY\\\\n${END}`;
    const out = normalizePrivateKey(pem);
    expect(out).toContain(`${BEGIN}\nBODY\n`);
    expect(out).not.toContain("\\");
  });
});

describe("isUserPatForEvidenceHtml", () => {
  it("accepts user PATs and rejects installation tokens", () => {
    expect(isUserPatForEvidenceHtml("ghp_abc")).toBe(true);
    expect(isUserPatForEvidenceHtml("github_pat_abc")).toBe(true);
    expect(isUserPatForEvidenceHtml("gho_abc")).toBe(true);
    expect(isUserPatForEvidenceHtml("ghs_installation")).toBe(false);
    expect(isUserPatForEvidenceHtml("")).toBe(false);
  });
});
