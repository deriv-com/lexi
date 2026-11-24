// Tests for the agent-fix shell helpers. Each script is run as a subprocess,
// exactly as the workflow runs it, against throwaway files and git repos.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const script = (name) => join(SCRIPTS, name);

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-fix-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function file(name, content) {
  const p = join(dir, name);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
}

describe("protected-paths.sh", () => {
  const protecting = (path, env = {}) =>
    run("bash", ["-c", `. "${script("protected-paths.sh")}"; lexi_protecting_pattern "$1"`, "_", path], {
      env: { PATH: process.env.PATH, ...env },
    });

  it.each([
    [".github/workflows/ci.yml", "*.yml"],
    ["k8s/deploy.YAML", "*.yaml"],
    ["pyproject.toml", "*.toml"],
    ["production/config.json", "production/*"],
    ["apps/web/production/flags.ts", "*/production/*"],
    ["./production.env", "production.*"],
    ["Production-Settings.ts", "production-*"],
  ])("protects %s", (path, pattern) => {
    const r = protecting(path);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe(pattern);
  });

  it.each(["src/app.ts", "docs/productionising.md", "README.md", ""])("does not protect %j", (path) => {
    expect(protecting(path).code).toBe(1);
  });

  it("replaces the defaults with a repository's own list", () => {
    const list = file("protected", "# ours\n\nsecrets/*\n  \n");
    expect(protecting("ci.yml", { LEXI_PROTECTED_PATHS_FILE: list }).code).toBe(1);
    const r = protecting("secrets/key.pem", { LEXI_PROTECTED_PATHS_FILE: list });
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("secrets/*");
  });
});

describe("check-brief.sh", () => {
  const check = (brief, cwd = dir) => run("bash", [script("check-brief.sh"), file("ctx.json", JSON.stringify({ brief }))], { cwd });

  it("passes a brief that names no protected path", () => {
    const r = check("The login button does nothing on src/login.ts");
    expect(r.code).toBe(0);
  });

  it("blocks a brief naming a workflow file, whether or not it exists", () => {
    const r = check("please edit .github/workflows/deploy.yml to add a step");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(".github/workflows/deploy.yml");
  });

  it("ignores 'production' as prose but blocks it as an existing path", () => {
    expect(check("this only breaks in production.").code).toBe(0);
    mkdirSync(join(dir, "production"));
    file("production/settings.ts", "");
    expect(check("look at production/settings.ts").code).toBe(1);
  });

  it("does nothing without a context file", () => {
    const r = run("bash", [script("check-brief.sh"), join(dir, "missing.json")]);
    expect(r.code).toBe(0);
  });
});

describe("pre-push", () => {
  const ZERO = "0".repeat(40);
  let repo, hooks;

  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

  beforeEach(() => {
    repo = join(dir, "repo");
    hooks = join(dir, "hooks");
    mkdirSync(repo);
    mkdirSync(hooks);
    for (const name of ["pre-push", "protected-paths.sh"]) {
      copyFileSync(script(name), join(hooks, name));
      chmodSync(join(hooks, name), 0o755);
    }
    git("init", "-q", "-b", "main");
    // A developer's global hooks have no business in this throwaway repo.
    git("config", "core.hooksPath", join(dir, "no-hooks"));
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "a.ts"), "1\n");
    git("add", ".");
    git("commit", "-qm", "base");
  });

  const commit = (path, content) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
    git("add", ".");
    git("commit", "-qm", `change ${path}`);
    return git("rev-parse", "HEAD");
  };

  const push = (branch, localSha, remoteSha) =>
    run(join(hooks, "pre-push"), ["origin", "url"], {
      cwd: repo,
      input: `refs/heads/${branch} ${localSha} refs/heads/${branch} ${remoteSha}\n`,
    });

  it("allows a prefixed branch with an ordinary change", () => {
    const base = git("rev-parse", "HEAD");
    const head = commit("src/b.ts", "2\n");
    expect(push("lexi/fix-b", head, base).code).toBe(0);
  });

  it("refuses a branch without the prefix", () => {
    const base = git("rev-parse", "HEAD");
    const head = commit("src/b.ts", "2\n");
    const r = push("feature/b", head, base);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('must start with "lexi/"');
  });

  it("refuses a push that changes a protected file", () => {
    const base = git("rev-parse", "HEAD");
    const head = commit(".github/workflows/ci.yml", "on: push\n");
    const r = push("lexi/ci", head, base);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(".github/workflows/ci.yml");
  });

  it("inspects the tip commit of a new branch", () => {
    const head = commit("deploy.yaml", "x: 1\n");
    expect(push("lexi/new", head, ZERO).code).toBe(1);
  });

  it("reads its configuration from guard.env, not the environment", () => {
    writeFileSync(join(hooks, "guard.env"), "LEXI_BRANCH_PREFIX=bot/\n");
    const base = git("rev-parse", "HEAD");
    const head = commit("src/c.ts", "3\n");
    expect(push("bot/c", head, base).code).toBe(0);
    const r = run(join(hooks, "pre-push"), ["origin", "url"], {
      cwd: repo,
      env: { ...process.env, LEXI_BRANCH_PREFIX: "lexi/" },
      input: `refs/heads/lexi/c ${head} refs/heads/lexi/c ${base}\n`,
    });
    expect(r.code).toBe(1);
  });

  it("runs the repository's own hook first", () => {
    mkdirSync(join(repo, ".githooks"));
    writeFileSync(join(repo, ".githooks/pre-push"), "#!/bin/sh\necho repo-hook-refused >&2\nexit 1\n");
    chmodSync(join(repo, ".githooks/pre-push"), 0o755);
    const base = git("rev-parse", "HEAD");
    const head = commit("src/d.ts", "4\n");
    const r = push("lexi/d", head, base);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("repo-hook-refused");
  });

  it("lets deletions through", () => {
    expect(push("lexi/gone", ZERO, git("rev-parse", "HEAD")).code).toBe(0);
  });
});

describe("duplicate-guard.sh", () => {
  const guard = (prs, issues, resumed) =>
    run("bash", [script("duplicate-guard.sh"), file("prs", prs), file("issues", issues), ...(resumed ? [resumed] : [])]);

  it("proceeds on a fresh thread", () => {
    const r = guard("", "");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("continues the one open PR", () => {
    const r = guard("42\n", "41\n");
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe("CONTINUE: pr=42");
  });

  it("blocks several open PRs", () => {
    const r = guard("42\n43\n", "");
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("DUPLICATE: pr=[42 43]");
  });

  it("blocks a leftover issue unless it is the one being resumed", () => {
    expect(guard("", "41\n").code).toBe(1);
    expect(guard("", "41\n", "41").code).toBe(0);
  });
});

describe("check-output-contract.sh", () => {
  const contract = (announcement, handback) => {
    const a = join(dir, "announcement.txt");
    const h = join(dir, "handback.txt");
    if (announcement !== undefined) writeFileSync(a, announcement);
    if (handback !== undefined) writeFileSync(h, handback);
    return run("bash", [script("check-output-contract.sh"), a, h]);
  };

  it("accepts an announcement alone", () => {
    expect(contract("PR opened").stdout.trim()).toBe("OUTCOME: shipped");
  });

  it("accepts a hand-back alone", () => {
    expect(contract(undefined, "needs a human").stdout.trim()).toBe("OUTCOME: handback");
  });

  it("rejects both", () => {
    expect(contract("a", "b").code).toBe(1);
  });

  it("rejects neither", () => {
    expect(contract().code).toBe(1);
  });

  it("treats an empty file as absent", () => {
    expect(contract("", undefined).code).toBe(1);
  });
});

describe("normalize-payload.sh", () => {
  const normalize = (payload) => run("bash", [script("normalize-payload.sh"), file("raw.json", payload)]);

  it("normalises a repository_dispatch payload", () => {
    const r = normalize(JSON.stringify({ brief: "x broke", requester: "U0TEST01", resume_pr_number: 7, extra: 1 }));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      brief: "x broke",
      requester: "U0TEST01",
      thread_ref: "",
      scope_hint: "",
      resume_issue_number: "",
      resume_pr_number: "7",
    });
  });

  it("accepts string numbers from workflow_dispatch and strips leading zeros", () => {
    const r = normalize(JSON.stringify({ brief: "b", requester: "r", resume_issue_number: "007", resume_pr_number: "" }));
    expect(JSON.parse(r.stdout)).toMatchObject({ resume_issue_number: "7", resume_pr_number: "" });
  });

  it.each([
    ["not json", "brief"],
    [JSON.stringify({ requester: "r" }), "brief"],
    [JSON.stringify({ brief: "b" }), "requester"],
    [JSON.stringify({ brief: "b", requester: "r", resume_pr_number: "7; rm -rf /" }), "resume_pr_number"],
    [JSON.stringify({ brief: "b", requester: "r", resume_issue_number: 0 }), "resume_issue_number"],
    [JSON.stringify({ brief: "b", requester: "r", resume_issue_number: 1.5 }), "resume_issue_number"],
  ])("rejects %s", (payload, field) => {
    const r = normalize(payload);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(field);
  });
});

describe("gh-credential-helper.sh", () => {
  const helper = (request, map) =>
    run("bash", [script("gh-credential-helper.sh"), "get"], {
      input: request,
      env: { PATH: process.env.PATH, GH_CREDENTIAL_MAP: map },
    });

  let map;
  beforeEach(() => {
    const read = file("token-read", "read-token\n");
    const write = file("token", "write-token\n");
    map = file("map", `# routes\nacme/shared-sdk=${read}\n*=${write}\n`);
  });

  it("routes a mapped repository to its own token", () => {
    const r = helper("protocol=https\nhost=github.com\npath=acme/shared-sdk.git\n\n", map);
    expect(r.stdout).toBe("username=x-access-token\npassword=read-token\n");
  });

  it("finds the map in the job's own directory, and never at a shared path", () => {
    const request = "protocol=https\nhost=github.com\npath=acme/web.git\n\n";
    const get = (env) => run("bash", [script("gh-credential-helper.sh"), "get"], { input: request, env: { PATH: process.env.PATH, ...env } });
    const job = join(dir, "job");
    mkdirSync(job);
    writeFileSync(join(job, "gh-credential-map"), `*=${join(dir, "token")}\n`);
    expect(get({ LEXI_JOB_DIR: job }).stdout).toBe("username=x-access-token\npassword=write-token\n");
    const none = get({});
    expect(none.code).toBe(0);
    expect(none.stdout).toBe("");
  });

  it("does not route a repository that merely shares the prefix", () => {
    const r = helper("protocol=https\nhost=github.com\npath=acme/shared-sdk-fork.git\n\n", map);
    expect(r.stdout).toContain("password=write-token");
  });

  it("answers nothing for another host or protocol", () => {
    expect(helper("protocol=https\nhost=example.com\n\n", map).stdout).toBe("");
    expect(helper("protocol=http\nhost=github.com\n\n", map).stdout).toBe("");
  });
});

// The sandbox is exercised against a fake /proc, with `kill` replaced by a
// function that removes the fake entry, so no real process is ever signalled.
// The test hooks only work outside GitHub Actions, so GITHUB_ACTIONS is left out.
describe("agent-sandbox.sh", () => {
  let proc;
  beforeEach(() => {
    proc = join(dir, "proc");
    mkdirSync(proc);
  });
  const fake = (pid, { comm = "sh", state = "S", ppid = 1, uid, start, env = {} }) => {
    const p = join(proc, String(pid));
    mkdirSync(p, { recursive: true });
    const tail = [state, ppid, pid, pid, 0, -1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, start, 0, 0].join(" ");
    writeFileSync(join(p, "stat"), `${pid} (${comm}) ${tail}\n`);
    writeFileSync(join(p, "status"), `Name:\t${comm}\nPPid:\t${ppid}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`);
    writeFileSync(join(p, "environ"), Object.entries(env).map(([k, v]) => `${k}=${v}\0`).join(""));
  };
  // Runs sandbox_stop in a bash (3.2 on macOS) that registers itself and its
  // parent in the fake /proc.
  const stop = (mark, env = {}, unkillable = []) =>
    run(
      "/bin/bash",
      [
        "-c",
        `p="$LEXI_SANDBOX_PROC"; mkdir -p "$p/$$" "$p/$PPID"
         printf '%s (bash) S %s 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1\\n' "$$" "$PPID" > "$p/$$/stat"
         printf 'PPid:\\t%s\\nUid:\\t%s\\n' "$PPID" "$UID_FAKE" > "$p/$$/status"
         printf '%s (node) S 1 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1\\n' "$PPID" > "$p/$PPID/stat"
         printf 'PPid:\\t1\\nUid:\\t%s\\n' "$UID_FAKE" > "$p/$PPID/status"
         . "${script("agent-sandbox.sh")}"
         kill() { echo "$1 $2" >> "$KILL_LOG"; case " $UNKILLABLE " in *" $2 "*) ;; *) [ "$1" = -KILL ] && rm -rf "$p/$2" ;; esac; return 0; }
         sandbox_stop "$1"; echo "rc=$?"`,
        "_",
        String(mark),
      ],
      {
        env: {
          PATH: process.env.PATH,
          LEXI_SANDBOX_PROC: proc,
          KILL_LOG: join(dir, "kills"),
          UNKILLABLE: unkillable.join(" "),
          ...env,
        },
      },
    );
  const killed = () => {
    const log = join(dir, "kills");
    if (!existsSync(log)) return [];
    return [...new Set(readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split(" ")[1]))].sort();
  };

  // UID is read-only in bash, so the fake processes use the real uid.
  const uid = Number(execFileSync("id", ["-u"], { encoding: "utf8" }).trim());

  it("stops every process of this user started after the mark, however it detached", () => {
    fake(2001, { uid, start: 1500 });
    fake(2002, { uid, start: 500 });
    fake(2003, { uid: uid + 1, start: 1500 });
    fake(2004, { uid, start: 1600, comm: "evil ) S 1 (x" });
    fake(2005, { uid, start: 1700, state: "Z" });
    const r = stop(1000, { UID_FAKE: String(uid) });
    expect(r.stdout).toContain("rc=0");
    expect(killed()).toEqual(["2001", "2004"]);
  });

  it("leaves another job's processes alone on a self-hosted runner, not on a GitHub-hosted one", () => {
    fake(2001, { uid, start: 1500, env: { RUNNER_TRACKING_ID: "other" } });
    fake(2002, { uid, start: 1500 });
    stop(1000, { UID_FAKE: String(uid), RUNNER_TRACKING_ID: "mine", RUNNER_ENVIRONMENT: "self-hosted" });
    expect(killed()).toEqual(["2002"]);
    fake(2002, { uid, start: 1500 });
    rmSync(join(dir, "kills"), { force: true });
    stop(1000, { UID_FAKE: String(uid), RUNNER_TRACKING_ID: "mine", RUNNER_ENVIRONMENT: "github-hosted" });
    expect(killed()).toEqual(["2001", "2002"]);
  });

  it("fails when a process cannot be stopped", () => {
    fake(2001, { uid, start: 1500 });
    const r = stop(1000, { UID_FAKE: String(uid) }, [2001]);
    expect(r.stdout).toContain("rc=1");
    expect(r.stderr).toContain("could not be stopped: 2001");
  }, 30000);

  it("refuses to guess without a mark", () => {
    fake(2001, { uid, start: 1500 });
    const r = stop("", { UID_FAKE: String(uid) });
    expect(r.stdout).toContain("rc=1");
    expect(killed()).toEqual([]);
  });

  it("ignores its test hooks inside GitHub Actions", () => {
    const r = run("bash", ["-c", `. "${script("agent-sandbox.sh")}"; _sandbox_test_hook x && echo honoured || echo ignored`], {
      env: { PATH: process.env.PATH, GITHUB_ACTIONS: "true" },
    });
    expect(r.stdout.trim()).toBe("ignored");
  });

  it("empties the step's file commands", () => {
    const envFile = file("env", "LD_PRELOAD=/tmp/x.so\n");
    const pathFile = file("path", "/tmp/evil\n");
    const out = file("out", "x=1\n");
    run("bash", [script("agent-sandbox.sh"), "reset-file-commands"], {
      env: { PATH: process.env.PATH, GITHUB_ENV: envFile, GITHUB_PATH: pathFile, GITHUB_OUTPUT: out },
    });
    for (const f of [envFile, pathFile, out]) expect(readFileSync(f, { encoding: "utf8" })).toBe("");
  });
});

// A local stand-in for the GitHub API; the script talks to it over HTTP.
describe("gh-token-mint.sh", () => {
  const { createServer } = require("node:http");
  const { execFile } = require("node:child_process");
  const { createPublicKey, createVerify } = require("node:crypto");
  let server;
  let seen;
  let base;
  let granted;
  beforeEach(async () => {
    seen = [];
    granted = undefined;
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
        const reply = (code, obj) => {
          res.writeHead(code, { "content-type": "application/json" });
          res.end(obj ? JSON.stringify(obj) : "");
        };
        if (req.method === "GET" && req.url === "/repos/acme/web/installation") return reply(200, { id: 42, permissions: granted });
        if (req.method === "POST" && req.url === "/app/installations/42/access_tokens")
          return reply(201, { token: "ghs_new_token", expires_at: "2026-11-11T12:00:00Z" });
        if (req.method === "DELETE" && req.url === "/installation/token") return reply(204);
        return reply(404, { message: "Not Found" });
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(() => server.close());

  const mint = (env) =>
    new Promise((resolve) => {
      execFile("bash", [script("gh-token-mint.sh")], { env, encoding: "utf8" }, (err, stdout, stderr) =>
        resolve({ code: err ? err.code : 0, stdout, stderr }),
      );
    });

  it("mints one narrowed token, masks it, and revokes the one it replaces", async () => {
    const key = execFileSync("openssl", ["genrsa", "2048"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const tokenFile = file("gh-token", "ghs_old_token");
    const output = file("output", "");
    // A curl planted earlier on PATH must never see the key or the JWT.
    const planted = join(dir, "planted");
    mkdirSync(planted);
    writeFileSync(join(planted, "curl"), `#!/bin/sh\necho used > "${join(dir, "planted-used")}"\nexit 1\n`);
    chmodSync(join(planted, "curl"), 0o755);

    const r = await mint({
      PATH: `${planted}:${process.env.PATH}`,
      HOME: dir,
      APP_ID: "123",
      // Single-line stores carry literal \n escapes.
      APP_PRIVATE_KEY: key.trim().replace(/\n/g, "\\n"),
      GITHUB_API_URL: base,
      GITHUB_REPOSITORY: "acme/web",
      REPOSITORIES: "web, shared-sdk",
      PERMISSIONS_JSON: '{"contents":"write"}',
      TOKEN_FILE: tokenFile,
      OUTPUT_NAME: "token",
      GITHUB_OUTPUT: output,
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(dir, "planted-used"))).toBe(false);
    expect(readFileSync(tokenFile, "utf8")).toBe("ghs_new_token");
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(output, "utf8")).toBe("token=ghs_new_token\n");
    expect(r.stdout).toContain("::add-mask::ghs_new_token");
    expect(r.stdout).toContain("::add-mask::ghs_old_token");
    expect(r.stdout.replace(/::add-mask::\S+/g, "")).not.toContain("ghs_");
    expect(r.stdout + r.stderr).not.toContain("PRIVATE KEY");

    const post = seen.find((s) => s.method === "POST");
    expect(JSON.parse(post.body)).toEqual({ repositories: ["web", "shared-sdk"], permissions: { contents: "write" } });
    // The JWT is a valid RS256 signature by the App's key.
    const [h, p, sig] = post.auth.replace("Bearer ", "").split(".");
    expect(JSON.parse(Buffer.from(p, "base64url")).iss).toBe("123");
    const ok = createVerify("RSA-SHA256").update(`${h}.${p}`).verify(createPublicKey(key), Buffer.from(sig, "base64url"));
    expect(ok).toBe(true);
    const revoke = seen.find((s) => s.method === "DELETE");
    expect(revoke.auth).toBe("Bearer ghs_old_token");
  });

  it("fails without writing anything when the key is unusable", async () => {
    const tokenFile = join(dir, "gh-token");
    const r = await mint({
      PATH: process.env.PATH,
      APP_ID: "123",
      APP_PRIVATE_KEY: "not a key",
      PERMISSIONS_JSON: '{"contents":"read"}',
      GITHUB_API_URL: base,
      GITHUB_REPOSITORY: "acme/web",
      TOKEN_FILE: tokenFile,
    });
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("not a usable PEM private key");
    expect(existsSync(tokenFile)).toBe(false);
    expect(seen).toEqual([]);
  });

  it("refuses a repository that is not a bare name", async () => {
    const r = await mint({ PATH: process.env.PATH, APP_ID: "1", APP_PRIVATE_KEY: "x", GITHUB_REPOSITORY: "acme/web", REPOSITORIES: "../other", PERMISSIONS_JSON: '{"contents":"read"}' });
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("must be a bare name");
  });

  // Without a permission set GitHub grants every permission the installation
  // has, so a step that forgot to name its permissions gets no token at all.
  it("refuses to mint without a permission set, before asking GitHub", async () => {
    const r = await mint({ PATH: process.env.PATH, APP_ID: "1", APP_PRIVATE_KEY: "x", GITHUB_API_URL: base, GITHUB_REPOSITORY: "acme/web" });
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain("PERMISSIONS_JSON is required");
    expect(seen).toEqual([]);
  });

  it("refuses an empty or malformed permission set", async () => {
    for (const bad of ["{}", '{"contents":"admin"}', "[]", "not json"]) {
      const r = await mint({ PATH: process.env.PATH, APP_ID: "1", APP_PRIVATE_KEY: "x", GITHUB_API_URL: base, GITHUB_REPOSITORY: "acme/web", PERMISSIONS_JSON: bad });
      expect(r.code, bad).not.toBe(0);
      expect(r.stdout).toContain("PERMISSIONS_JSON must be");
    }
    expect(seen).toEqual([]);
  });

  it("adds an optional permission only where the installation grants it", async () => {
    const key = execFileSync("openssl", ["genrsa", "2048"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    granted = { contents: "write", pull_requests: "write", issues: "read", checks: "read" };
    const r = await mint({
      PATH: process.env.PATH,
      HOME: dir,
      APP_ID: "123",
      APP_PRIVATE_KEY: key,
      GITHUB_API_URL: base,
      GITHUB_REPOSITORY: "acme/web",
      PERMISSIONS_JSON: '{"contents":"read","pull_requests":"read"}',
      // actions is not granted; issues only at read; contents stays at the required level.
      OPTIONAL_PERMISSIONS_JSON: '{"checks":"read","actions":"read","issues":"write","contents":"write"}',
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const post = seen.find((s) => s.method === "POST");
    expect(JSON.parse(post.body).permissions).toEqual({ contents: "read", pull_requests: "read", checks: "read" });
  });
});

// The segment runner keeps every file in the job's own directory
// (LEXI_JOB_DIR), as the workflow does: never at a fixed path under /tmp,
// which two jobs on one runner host would share.
describe("run-agent-segment.sh", () => {
  const SHARED = ["agent-fix-deadline-epoch", "announcement.txt", "handback.txt", "run.jsonl", "agent-fix-session"].map((f) => `/tmp/${f}`);
  let job;
  let sharedBefore;
  beforeEach(() => {
    job = join(dir, "job");
    mkdirSync(job);
    sharedBefore = SHARED.filter((f) => existsSync(f));
  });
  afterEach(() => {
    // Nothing the script did may have landed on the shared paths.
    expect(SHARED.filter((f) => existsSync(f))).toEqual(sharedBefore);
  });

  // mode: "pause" (the segment limit ends it), "ship" (writes a result), "inject"
  const segment = (n, last, mode, deadlineIn = 3600) => {
    writeFileSync(join(job, "agent-fix-deadline-epoch"), String(Math.floor(Date.now() / 1000) + deadlineIn));
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/bash
printf '%s\\n' "$@" > "${join(dir, "argv")}-${n}"
echo '{"type":"system","subtype":"init","session_id":"sess-${n}"}'
case "${mode}" in
  ship) echo "Fixed. PR: https://github.com/acme/web/pull/1" > "$LEXI_JOB_DIR/announcement.txt"; exit 0 ;;
  inject) echo "LD_PRELOAD=/tmp/evil.so" >> "$GITHUB_ENV"; echo /tmp/evil >> "$GITHUB_PATH"; exit 124 ;;
  *) exit 124 ;;
esac
`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    const envFile = file(`env-${n}`, "");
    const pathFile = file(`path-${n}`, "");
    const r = run("bash", [script("run-agent-segment.sh"), String(n), String(last)], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_ENV: envFile,
        GITHUB_PATH: pathFile,
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "acme/web",
        GITHUB_RUN_ID: "1",
        GITHUB_WORKSPACE: dir,
        MODEL: "m",
        MODEL_API_KEY: "k",
        MAX_TURNS: "5",
        SKILL: "fix",
        BRANCH_PREFIX: "lexi/",
        SEGMENT_MINUTES: "10",
        LEXI_JOB_DIR: job,
        STUB_DIR: dir,
        LEXI_SANDBOX_REQUIRE_ENV: `STUB_DIR=${dir}`,
      },
    });
    return { ...r, env: readFileSync(envFile, "utf8"), path: readFileSync(pathFile, "utf8") };
  };

  it("pauses at the segment limit and resumes the same conversation", () => {
    const first = segment(1, 7, "pause");
    expect(first.code, first.stdout + first.stderr).toBe(0);
    expect(first.env).toBe("AGENT_CONTINUE=true\n");
    expect(readFileSync(join(job, "agent-fix-session"), "utf8")).toBe("sess-1");
    const second = segment(2, 7, "ship");
    expect(second.code).toBe(0);
    expect(second.env).toBe("AGENT_CONTINUE=false\n");
    const argv = readFileSync(join(dir, "argv-2"), "utf8").split("\n");
    expect(argv[argv.indexOf("--resume") + 1]).toBe("sess-1");
    expect(readFileSync(join(job, "run.jsonl"), "utf8").match(/"init"/g)).toHaveLength(2);
  });

  it("tells the agent where this job's files are", () => {
    segment(1, 7, "ship");
    const prompt = readFileSync(join(dir, "argv-1"), "utf8");
    expect(prompt).toContain(`${job}/ctx.json`);
    expect(prompt).toContain(`${job}/announcement.txt`);
    expect(prompt).not.toMatch(/\/tmp\/(ctx\.json|announcement\.txt|handback\.txt|agent-fix-deadline-epoch)/);
  });

  it("refuses to run without the job's own directory", () => {
    const envFile = file("env-x", "");
    const r = run("bash", [script("run-agent-segment.sh"), "1", "7"], {
      env: { PATH: process.env.PATH, GITHUB_ENV: envFile, GITHUB_SERVER_URL: "s", GITHUB_REPOSITORY: "r", GITHUB_RUN_ID: "1", LEXI_SANDBOX: "off" },
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("LEXI_JOB_DIR");
    expect(readFileSync(envFile, "utf8")).toBe("AGENT_CONTINUE=false\n");
  });

  it("drops whatever the agent wrote to the step's file commands", () => {
    const r = segment(1, 7, "inject");
    expect(r.env).toBe("AGENT_CONTINUE=true\n");
    expect(r.path).toBe("");
  });

  it("hands back when the last segment ends without a result", () => {
    writeFileSync(join(job, "agent-fix-session"), "sess-6");
    const r = segment(7, 7, "pause");
    expect(r.code).toBe(124);
    expect(r.env).toBe("AGENT_CONTINUE=false\n");
    expect(readFileSync(join(job, "handback.txt"), "utf8")).toContain("used all 7 agent segments");
  });

  it("does not resume without a conversation to resume", () => {
    const r = segment(2, 7, "ship");
    expect(r.code).toBe(1);
    expect(existsSync(join(dir, "argv-2"))).toBe(false);
    expect(readFileSync(join(job, "handback.txt"), "utf8")).toContain("could not resume");
  });

  it("does not start the agent when setup used the budget", () => {
    const r = segment(1, 7, "ship", 30);
    expect(r.code).toBe(1);
    expect(existsSync(join(dir, "argv-1"))).toBe(false);
    expect(readFileSync(join(job, "handback.txt"), "utf8")).toContain("used the whole budget");
    expect(r.env).toBe("AGENT_CONTINUE=false\n");
  });
});

