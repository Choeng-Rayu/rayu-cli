// EngineResolver: bundled-engine resolution and integrity verification.
//
// This replaced `CliLocator`. The engine now ships inside the VSIX, so there is
// nothing to search for on the user's machine — what matters is proving the
// shipped artifact is the one this extension was built against, and REFUSING to
// run it otherwise.
//
// Every test drives the injected filesystem, so nothing here touches real files.

import { describe, expect, it } from "vitest";

import {
  BUILD_INFO_FILENAME,
  EngineResolutionError,
  EngineResolver,
  ensureFirstRunMarkerSuppressed,
  resolveEngineConfigDir,
  type BuildInfo,
  type EngineFileSystem,
} from "../src/index.js";

const DIST = "/ext/dist";
const GOOD_DIGEST = "a".repeat(64);

function validBuildInfo(overrides: Partial<BuildInfo> = {}): BuildInfo {
  return {
    engineVersion: "1.6.13",
    engineFile: "rayu.js",
    engineSha256: GOOD_DIGEST,
    protocolVersion: 1,
    gitCommit: "b".repeat(40),
    extensionVersion: "0.2.0",
    builtAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

interface FakeFsOptions {
  manifest?: string | undefined;
  engineBytes?: Uint8Array | undefined;
}

function makeFs(options: FakeFsOptions = {}): {
  fs: EngineFileSystem;
  written: Map<string, string>;
  dirs: string[];
} {
  const written = new Map<string, string>();
  const dirs: string[] = [];
  const files = new Map<string, string>();
  if (options.manifest !== undefined) {
    files.set(`${DIST}/${BUILD_INFO_FILENAME}`, options.manifest);
  }
  const engine = options.engineBytes;
  if (engine !== undefined) {
    files.set(`${DIST}/rayu.js`, "<engine>");
  }
  const fs: EngineFileSystem = {
    exists: (p) => files.has(p) || written.has(p),
    readFile: (p) => {
      const value = files.get(p) ?? written.get(p);
      if (value === undefined) throw new Error(`ENOENT ${p}`);
      return value;
    },
    readFileBytes: () => engine ?? new Uint8Array(),
    mkdirp: (p) => dirs.push(p),
    writeFile: (p, c) => written.set(p, c),
  };
  return { fs, written, dirs };
}

function makeAdapter(): {
  adapter: { log: (channel: string, message: string) => void };
  logs: { channel: string; message: string }[];
} {
  const logs: { channel: string; message: string }[] = [];
  return {
    adapter: { log: (channel, message) => logs.push({ channel, message }) },
    logs,
  };
}

describe("EngineResolver happy path", () => {
  it("resolves the engine and reports the verified provenance", () => {
    const { fs } = makeFs({
      manifest: JSON.stringify(validBuildInfo()),
      engineBytes: new Uint8Array([1, 2, 3]),
    });
    const { adapter, logs } = makeAdapter();
    const resolver = new EngineResolver({
      distDir: DIST,
      adapter,
      fs,
      computeSha256: () => GOOD_DIGEST,
    });

    const resolution = resolver.resolve();

    expect(resolution.enginePath).toBe(`${DIST}/rayu.js`);
    expect(resolution.buildInfo.engineVersion).toBe("1.6.13");
    expect(resolution.buildInfo.protocolVersion).toBe(1);
    expect(
      logs.some(
        (l) => l.channel === "lifecycle" && /engine verified/i.test(l.message),
      ),
    ).toBe(true);
  });

  it("computes the digest only ONCE and caches the resolution", () => {
    // The engine is ~24 MB and cannot change under a running extension, so
    // re-hashing per spawn would be wasted work (PROTOCOL.md §6.1).
    let hashCalls = 0;
    const { fs } = makeFs({
      manifest: JSON.stringify(validBuildInfo()),
      engineBytes: new Uint8Array([1]),
    });
    const { adapter } = makeAdapter();
    const resolver = new EngineResolver({
      distDir: DIST,
      adapter,
      fs,
      computeSha256: () => {
        hashCalls += 1;
        return GOOD_DIGEST;
      },
    });

    const first = resolver.resolve();
    const second = resolver.resolve();

    expect(hashCalls).toBe(1);
    expect(second).toBe(first);
  });

  it("accepts an upper-case digest in the manifest", () => {
    const { fs } = makeFs({
      manifest: JSON.stringify(
        validBuildInfo({ engineSha256: GOOD_DIGEST.toUpperCase() }),
      ),
      engineBytes: new Uint8Array([1]),
    });
    const { adapter } = makeAdapter();
    expect(() =>
      new EngineResolver({
        distDir: DIST,
        adapter,
        fs,
        computeSha256: () => GOOD_DIGEST,
      }).resolve(),
    ).not.toThrow();
  });
});

describe("EngineResolver refuses to run an unverified engine", () => {
  function expectRefusal(
    options: FakeFsOptions,
    computeSha256: () => string,
    matcher: RegExp,
  ): void {
    const { fs } = makeFs(options);
    const { adapter } = makeAdapter();
    const resolver = new EngineResolver({
      distDir: DIST,
      adapter,
      fs,
      computeSha256,
    });
    expect(() => resolver.resolve()).toThrow(EngineResolutionError);
    expect(() => resolver.resolve()).toThrow(matcher);
  }

  it("refuses when the digest does not match", () => {
    // The whole point of the check: a tampered or inconsistently-packaged engine
    // must NOT be executed.
    expectRefusal(
      {
        manifest: JSON.stringify(validBuildInfo()),
        engineBytes: new Uint8Array([9]),
      },
      () => "f".repeat(64),
      /integrity check/i,
    );
  });

  it("refuses when build-info.json is missing", () => {
    // Without the manifest neither the integrity nor the compatibility check can
    // run, so proceeding would silently discard both guarantees.
    expectRefusal({ engineBytes: new Uint8Array([1]) }, () => GOOD_DIGEST, /missing/i);
  });

  it("refuses when build-info.json is not valid JSON", () => {
    expectRefusal(
      { manifest: "{ not json", engineBytes: new Uint8Array([1]) },
      () => GOOD_DIGEST,
      /not valid JSON/i,
    );
  });

  it("refuses when the engine file is absent", () => {
    expectRefusal(
      { manifest: JSON.stringify(validBuildInfo()) },
      () => GOOD_DIGEST,
      /engine is missing/i,
    );
  });

  it("refuses a digest that is not 64 hex characters", () => {
    expectRefusal(
      {
        manifest: JSON.stringify(validBuildInfo({ engineSha256: "abc123" })),
        engineBytes: new Uint8Array([1]),
      },
      () => GOOD_DIGEST,
      /64-character hex/i,
    );
  });

  it("names the offending field when a required one is missing", () => {
    for (const field of [
      "engineVersion",
      "engineFile",
      "gitCommit",
      "extensionVersion",
      "builtAt",
    ] as const) {
      const info = validBuildInfo();
      delete (info as Record<string, unknown>)[field];
      expectRefusal(
        {
          manifest: JSON.stringify(info),
          engineBytes: new Uint8Array([1]),
        },
        () => GOOD_DIGEST,
        new RegExp(field),
      );
    }
  });

  it("rejects a non-numeric protocolVersion", () => {
    expectRefusal(
      {
        manifest: JSON.stringify(
          validBuildInfo({ protocolVersion: "1" as unknown as number }),
        ),
        engineBytes: new Uint8Array([1]),
      },
      () => GOOD_DIGEST,
      /protocolVersion/,
    );
  });
});

describe("engine config dir resolution", () => {
  it("prefers RAYU_CONFIG_DIR", () => {
    expect(
      resolveEngineConfigDir({ RAYU_CONFIG_DIR: "/custom/cfg" }, "/home/u"),
    ).toBe("/custom/cfg");
  });

  it("falls back to ~/.rayu", () => {
    // Mirrors the engine's own precedence in rayu/src/utils/envUtils.ts; if these
    // diverge the marker is written where the engine will not look for it.
    expect(resolveEngineConfigDir({}, "/home/u")).toBe("/home/u/.rayu");
  });

  it("ignores an empty RAYU_CONFIG_DIR", () => {
    expect(resolveEngineConfigDir({ RAYU_CONFIG_DIR: "" }, "/home/u")).toBe(
      "/home/u/.rayu",
    );
  });
});

describe("first-run banner suppression", () => {
  it("creates the marker when absent", () => {
    // The engine writes a 17-line welcome banner to STDOUT, guarded only by this
    // marker, and it does so before the stream-json stdout guard installs. In
    // NDJSON mode those lines are not JSON, so the decode boundary correctly
    // fails the session — which would break the FIRST session after every
    // install, since a new machine has no config dir (rayucode/TRIAGE.md D4).
    const { fs, written, dirs } = makeFs();
    const { adapter } = makeAdapter();

    const ok = ensureFirstRunMarkerSuppressed({
      adapter,
      fs,
      env: {},
      home: "/home/u",
    });

    expect(ok).toBe(true);
    expect(dirs).toContain("/home/u/.rayu");
    expect(written.has("/home/u/.rayu/.installed")).toBe(true);
  });

  it("is a no-op when the marker already exists", () => {
    const { fs, written } = makeFs();
    const { adapter } = makeAdapter();
    // Pre-create it.
    ensureFirstRunMarkerSuppressed({ adapter, fs, env: {}, home: "/home/u" });
    const countAfterFirst = written.size;

    ensureFirstRunMarkerSuppressed({ adapter, fs, env: {}, home: "/home/u" });

    expect(written.size).toBe(countAfterFirst);
  });

  it("honours RAYU_CONFIG_DIR", () => {
    const { fs, written } = makeFs();
    const { adapter } = makeAdapter();

    ensureFirstRunMarkerSuppressed({
      adapter,
      fs,
      env: { RAYU_CONFIG_DIR: "/cfg" },
      home: "/home/u",
    });

    expect(written.has("/cfg/.installed")).toBe(true);
  });

  it("degrades to false and logs when the marker cannot be written", () => {
    // Best-effort by design: a read-only home must not prevent the extension
    // from starting. If the banner then appears, the decode boundary fails the
    // session with a clear protocol error rather than hanging.
    const { adapter, logs } = makeAdapter();
    const fs: EngineFileSystem = {
      exists: () => false,
      readFile: () => "",
      readFileBytes: () => new Uint8Array(),
      mkdirp: () => {
        throw new Error("EROFS: read-only file system");
      },
      writeFile: () => {
        throw new Error("EROFS");
      },
    };

    const ok = ensureFirstRunMarkerSuppressed({
      adapter,
      fs,
      env: {},
      home: "/home/u",
    });

    expect(ok).toBe(false);
    expect(logs.some((l) => l.channel === "error")).toBe(true);
  });
});
