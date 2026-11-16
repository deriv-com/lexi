import { describe, expect, it } from "vitest";
import {
  extractParityInventory,
  isParityLocalePath,
  isParityRoutePath,
  isParityScreenPath,
  isParitySourcePath,
  PARITY_LIST_CAP,
  selectParityFiles,
  type ParityInventoryFile,
} from "./parity-inventory";

/* ------------------------------------------------------------------------ */
/* Fixtures                                                                  */
/* ------------------------------------------------------------------------ */

const NEXT_APP_ROUTER: ParityInventoryFile[] = [
  {
    path: "package.json",
    content: JSON.stringify({
      name: "web-app",
      dependencies: { react: "^18.3.0", next: "14.2.0", "@acme/ui-kit": "1.0.0" },
      devDependencies: { vitest: "^2.0.0" },
    }),
  },
  { path: "app/page.tsx", content: "export default function Page() { return <Home />; }" },
  { path: "app/layout.tsx", content: "export default function RootLayout() {}" },
  {
    path: "app/(marketing)/about/page.tsx",
    content: "export default function AboutPage() { return null; }",
  },
  { path: "app/trade/[id]/page.tsx", content: "export default function Page() {}" },
  { path: "app/@modal/login/page.tsx", content: "" },
  { path: "app/api/health/route.ts", content: "export function GET() {}" },
  {
    path: "src/features/wallet/WalletScreen.tsx",
    content: [
      "const enabled = useFeatureFlag('wallet_v2');",
      "if (isFeatureEnabled(\"crypto-cashier\")) {}",
      "if (flags.newOnboarding && flags.length) {}",
      "const v = getFeatureValue('pricing_experiment', 'control');",
      "analytics.track('wallet_opened');",
      "trackEvent(\"deposit_clicked\");",
      "rudderanalytics.track('withdraw_clicked', {});",
      "const url = process.env.NEXT_PUBLIC_API_URL;",
      "const mode = process.env.NODE_ENV;",
      "const k = process.env['SENTRY_DSN'];",
      "const v2 = import.meta.env.VITE_WS_URL;",
    ].join("\n"),
  },
  { path: "src/components/pages/Dashboard.tsx", content: "export const Dashboard = () => null;" },
  { path: "src/components/pages/index.ts", content: "export * from './Dashboard';" },
  { path: "src/features/wallet/WalletScreen.test.tsx", content: "track('should_not_count')" },
  { path: "public/locales/en/common.json", content: JSON.stringify({ a: "1", nested: { b: "2", c: "3" } }) },
  { path: "public/locales/en/trade.json", content: JSON.stringify({ d: "4" }) },
  { path: "public/locales/fr/common.json", content: JSON.stringify({ a: "1", nested: { b: "2", c: "3" } }) },
  { path: ".env.example", content: "# comment\nNEXT_PUBLIC_API_URL=https://x\nexport DATABASE_URL=\nSENTRY_DSN=abc\n" },
  { path: "README.md", content: "# home" },
  { path: "public/logo.png" },
];

const NEXT_PAGES_ROUTER: ParityInventoryFile[] = [
  { path: "package.json", content: JSON.stringify({ dependencies: { next: "13.0.0" } }) },
  { path: "src/pages/index.tsx", content: "export default function HomePage() {}" },
  { path: "src/pages/_app.tsx", content: "export default function App() {}" },
  { path: "src/pages/_document.tsx", content: "" },
  { path: "src/pages/reports/index.tsx", content: "export default function Page() {}" },
  { path: "src/pages/reports/[reportId].tsx", content: "const ReportDetail = () => null;\nexport default ReportDetail;" },
  { path: "src/pages/api/hello.ts", content: "export default function handler() {}" },
  { path: "src/pages/reports/__tests__/index.test.tsx", content: "" },
];

const REACT_ROUTER: ParityInventoryFile[] = [
  { path: "package.json", content: JSON.stringify({ dependencies: { "react-router-dom": "^6.0.0" } }) },
  {
    path: "src/routes/index.tsx",
    content: [
      "export const router = createBrowserRouter([",
      "  { path: '/', element: <Home /> },",
      "  { path: \"/trade/:symbol\", element: <Trade /> },",
      "  { path: `/settings`, element: <Settings /> },",
      "]);",
      "<Route path=\"/legacy\" element={<Legacy />} />",
    ].join("\n"),
  },
  { path: "src/screens/Home.tsx", content: "export const Home = () => null;" },
  { path: "src/screens/Trade.tsx", content: "" },
  { path: "src/lib/api.ts", content: "fetch(process.env.REACT_APP_API);" },
  // A `path:` literal outside a router file and outside router context must not count.
  { path: "src/lib/upload.ts", content: "const opts = { path: '/tmp/upload' };" },
];

const FLUTTER: ParityInventoryFile[] = [
  {
    path: "pubspec.yaml",
    content: [
      "name: acme_mobile",
      "dependencies:",
      "  flutter:",
      "    sdk: flutter",
      "  go_router: ^13.0.0",
      "  firebase_analytics: 10.1.0",
      "  acme_ui_kit:",
      "    git:",
      "      url: https://example.invalid/ui-kit.git",
      "  local_pkg:",
      "    path: ../local",
      "  intl: any",
      "dev_dependencies:",
      "  flutter_test:",
      "    sdk: flutter",
    ].join("\n"),
  },
  {
    path: "lib/router.dart",
    content: [
      "final router = GoRouter(routes: [",
      "  GoRoute(path: '/', builder: (c, s) => const HomeScreen()),",
      "  GoRoute(path: '/trade/:symbol', builder: (c, s) => const TradeScreen()),",
      "]);",
      "Navigator.pushNamed(context, '/settings');",
      "RouteSettings(name: '/legacy-dialog')",
    ].join("\n"),
  },
  {
    path: "lib/main.dart",
    content: [
      "MaterialApp(initialRoute: '/', routes: {",
      "  '/': (context) => const HomeScreen(),",
      "  '/deposit': (context) => const DepositScreen(),",
      "});",
      "const apiUrl = String.fromEnvironment('API_URL');",
      "const debug = bool.fromEnvironment('DEBUG_MENU');",
    ].join("\n"),
  },
  {
    path: "lib/features/trade/trade_screen.dart",
    content: [
      "class TradeScreen extends StatelessWidget {}",
      "final rc = FirebaseRemoteConfig.instance;",
      "final on = rc.getBool('new_trade_ui');",
      "final tier = rc.getString('pricing_tier');",
      "FirebaseAnalytics.instance.logEvent(name: 'trade_opened', parameters: {});",
      "analytics.logEvent('order_placed');",
    ].join("\n"),
  },
  { path: "lib/screens/home_screen.dart", content: "class HomeScreen extends StatefulWidget {}" },
  { path: "lib/models/user.g.dart", content: "logEvent('generated_noise')" },
  {
    path: "lib/l10n/app_en.arb",
    content: JSON.stringify({ "@@locale": "en", hello: "Hello", "@hello": { description: "x" }, bye: "Bye" }),
  },
  { path: "lib/l10n/app_de.arb", content: JSON.stringify({ "@@locale": "de", hello: "Hallo", bye: "Tschüss" }) },
];

/* ------------------------------------------------------------------------ */

describe("extractParityInventory — Next.js app router", () => {
  const doc = extractParityInventory({ files: NEXT_APP_ROUTER });

  it("detects the platform from package.json", () => {
    expect(doc.platform).toBe("web");
  });

  it("derives route paths, dropping route groups and slots and ignoring API routes", () => {
    expect(doc.routes).toEqual(["/", "/about", "/login", "/trade/[id]"]);
  });

  it("names screens from the default export or the route, plus pages/ and features/ files", () => {
    expect(doc.screens).toEqual([
      "AboutPage", // named default export
      "Dashboard", // src/components/pages/*
      "IndexPage", // app/page.tsx with the template `Page` name
      "LoginPage",
      "TradeIdPage",
      "WalletScreen", // features/**/*Screen.tsx
    ]);
  });

  it("collects feature flags, skipping array-method noise on `flags.`", () => {
    expect(doc.features).toEqual(["crypto-cashier", "newOnboarding", "pricing_experiment", "wallet_v2"]);
  });

  it("collects analytics events but never from test files", () => {
    expect(doc.analyticsEvents).toEqual(["deposit_clicked", "wallet_opened", "withdraw_clicked"]);
  });

  it("counts English locale leaf keys only", () => {
    expect(doc.i18nKeyCount).toBe(4);
  });

  it("merges env names from source and .env.example, dropping NODE_ENV", () => {
    expect(doc.envVars).toEqual([
      "DATABASE_URL",
      "NEXT_PUBLIC_API_URL",
      "SENTRY_DSN",
      "VITE_WS_URL",
    ]);
  });

  it("records runtime dependencies only, sorted", () => {
    expect(Object.keys(doc.dependencies)).toEqual(["@acme/ui-kit", "next", "react"]);
    expect(doc.dependencies.next).toBe("14.2.0");
  });

  it("counts every listed file and notes nothing missing when everything relevant was read", () => {
    expect(doc.fileCount).toBe(NEXT_APP_ROUTER.length);
    expect(doc.notes).toEqual([]);
  });

  it("is deterministic regardless of input order", () => {
    const reversed = extractParityInventory({ files: [...NEXT_APP_ROUTER].reverse() });
    expect(reversed).toEqual(doc);
  });
});

describe("extractParityInventory — Next.js pages router", () => {
  const doc = extractParityInventory({ files: NEXT_PAGES_ROUTER });

  it("maps index files to their directory and skips _app/_document/api/tests", () => {
    expect(doc.routes).toEqual(["/", "/reports", "/reports/[reportId]"]);
  });

  it("names screens from named exports, `export default Name;` and the route", () => {
    expect(doc.screens).toEqual(["HomePage", "ReportDetail", "ReportsPage"]);
  });
});

describe("extractParityInventory — React Router", () => {
  const doc = extractParityInventory({ files: REACT_ROUTER });

  it("reads path literals from router files only", () => {
    expect(doc.routes).toEqual(["/", "/legacy", "/settings", "/trade/:symbol"]);
  });

  it("lists screens/ files as screens", () => {
    expect(doc.screens).toEqual(["Home", "Trade"]);
  });

  it("finds env vars anywhere in source", () => {
    expect(doc.envVars).toEqual(["REACT_APP_API"]);
  });

  it("notes the absence of locale files honestly", () => {
    expect(doc.notes).toContain("no locale files found; i18nKeyCount is 0");
  });
});

describe("extractParityInventory — Flutter", () => {
  const doc = extractParityInventory({ files: FLUTTER });

  it("detects flutter from pubspec.yaml", () => {
    expect(doc.platform).toBe("flutter");
  });

  it("reads GoRoute, routes: map keys, pushNamed and RouteSettings literals", () => {
    expect(doc.routes).toEqual(["/", "/deposit", "/legacy-dialog", "/settings", "/trade/:symbol"]);
  });

  it("names screens from *Screen classes and screens/ files, ignoring generated code", () => {
    expect(doc.screens).toEqual(["HomeScreen", "TradeScreen"]);
  });

  it("reads Remote Config keys as features when the file uses RemoteConfig", () => {
    expect(doc.features).toEqual(["new_trade_ui", "pricing_tier"]);
  });

  it("reads both logEvent forms and skips .g.dart files", () => {
    expect(doc.analyticsEvents).toEqual(["order_placed", "trade_opened"]);
  });

  it("counts English ARB strings, excluding @metadata", () => {
    expect(doc.i18nKeyCount).toBe(2);
  });

  it("reads fromEnvironment names", () => {
    expect(doc.envVars).toEqual(["API_URL", "DEBUG_MENU"]);
  });

  it("summarises pubspec dependencies including sdk/git/path forms", () => {
    expect(doc.dependencies).toEqual({
      firebase_analytics: "10.1.0",
      flutter: "sdk:flutter",
      go_router: "^13.0.0",
      intl: "any",
      local_pkg: "path",
      acme_ui_kit: "git",
    });
  });
});

describe("extractParityInventory — gaps and caps", () => {
  it("falls back to platform unknown and says so when there is no manifest", () => {
    const doc = extractParityInventory({ files: [{ path: "src/index.ts", content: "" }] });
    expect(doc.platform).toBe("unknown");
    expect(doc.notes).toContain("no package.json or pubspec.yaml at the repo root; dependencies are unknown");
    expect(doc.notes).toContain("no route declarations recognised");
  });

  it("honours an explicit platform override", () => {
    const doc = extractParityInventory({ files: [], platform: "web" });
    expect(doc.platform).toBe("web");
  });

  it("inspects unread files by path only and notes how many", () => {
    const doc = extractParityInventory({
      files: [
        { path: "package.json" },
        { path: "app/trade/page.tsx" },
        { path: "public/locales/en.json" },
        { path: "src/lib/a.ts" },
        { path: "public/hero.png" },
      ],
    });
    expect(doc.routes).toEqual(["/trade"]);
    expect(doc.screens).toEqual(["TradePage"]);
    expect(doc.dependencies).toEqual({});
    expect(doc.notes).toContain("package.json was listed but not read; dependencies are unknown");
    expect(doc.notes).toContain("1 of 1 locale files were not read; i18nKeyCount is a lower bound");
    expect(doc.notes).toContain(
      "4 relevant files (source, manifest, locale or env) were listed without content and were inspected by path only",
    );
  });

  it("notes unparseable manifests and locale files instead of throwing", () => {
    const doc = extractParityInventory({
      files: [
        { path: "package.json", content: "{not json" },
        { path: "locales/en.json", content: "[oops" },
      ],
    });
    expect(doc.dependencies).toEqual({});
    expect(doc.notes).toContain("package.json is not valid JSON; dependencies were not inspected");
    expect(doc.notes).toContain("locales/en.json is not valid JSON; its keys were not counted");
  });

  it("caps every list at PARITY_LIST_CAP with a note", () => {
    const lines: string[] = [];
    for (let i = 0; i < PARITY_LIST_CAP + 5; i += 1) lines.push(`track('event_${String(i).padStart(4, "0")}');`);
    const doc = extractParityInventory({
      files: [{ path: "src/a.ts", content: lines.join("\n") }],
    });
    expect(doc.analyticsEvents).toHaveLength(PARITY_LIST_CAP);
    expect(doc.analyticsEvents[0]).toBe("event_0000");
    expect(doc.notes).toContain(`analyticsEvents list capped at ${PARITY_LIST_CAP} (${PARITY_LIST_CAP + 5} found)`);
  });

  it("dedupes paths and strips a leading slash", () => {
    const doc = extractParityInventory({
      files: [
        { path: "/app/page.tsx", content: "" },
        { path: "app/page.tsx", content: "" },
      ],
    });
    expect(doc.fileCount).toBe(1);
    expect(doc.routes).toEqual(["/"]);
  });
});

describe("path classifiers", () => {
  it("recognises source, route, screen and locale paths", () => {
    expect(isParitySourcePath("src/a.ts")).toBe(true);
    expect(isParitySourcePath("src/a.spec.ts")).toBe(false);
    expect(isParitySourcePath("node_modules/x/index.js")).toBe(false);
    expect(isParitySourcePath("lib/x.g.dart")).toBe(false);
    expect(isParitySourcePath("types/x.d.ts")).toBe(false);
    expect(isParityRoutePath("apps/web/src/app/(a)/b/page.tsx")).toBe(true);
    expect(isParityRoutePath("src/components/pages/Home.tsx")).toBe(false);
    expect(isParityScreenPath("src/components/pages/Home.tsx")).toBe(true);
    expect(isParityScreenPath("src/router/index.tsx")).toBe(true);
    expect(isParityLocalePath("public/locales/en-US/common.json")).toBe(true);
    expect(isParityLocalePath("public/locales/fr/common.json")).toBe(false);
    expect(isParityLocalePath("lib/l10n/intl_en.arb")).toBe(true);
    expect(isParityLocalePath("src/i18n/english.json")).toBe(false);
  });
});

describe("selectParityFiles", () => {
  const paths = [
    "src/lib/z.ts",
    "src/lib/a.ts",
    "src/screens/Home.tsx",
    "public/locales/en/common.json",
    ".env.example",
    "package.json",
    "README.md",
    "public/logo.png",
    "node_modules/x/index.js",
    "src/a.spec.ts",
    "docs/notes.ts",
  ];

  it("orders manifests, env, locales, screens/routes, then source, alphabetically within each tier", () => {
    const { selected, skippedSourceFiles } = selectParityFiles(paths, { maxFiles: 100 });
    expect(selected).toEqual([
      ".env.example",
      "package.json",
      "public/locales/en/common.json",
      "src/screens/Home.tsx",
      "src/lib/a.ts",
      "src/lib/z.ts",
    ]);
    expect(skippedSourceFiles).toBe(0);
  });

  it("respects the budget and counts what fell outside it", () => {
    const { selected, skippedSourceFiles } = selectParityFiles(paths, { maxFiles: 4 });
    expect(selected).toEqual([".env.example", "package.json", "public/locales/en/common.json", "src/screens/Home.tsx"]);
    expect(skippedSourceFiles).toBe(2);
  });
});
