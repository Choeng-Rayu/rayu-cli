import { describe, expect, it } from "vitest";

import { Redactor } from "@rayucode/core";

import {
  collectEnvironmentSecrets,
  isCredentialName,
  isPlausibleSecret,
} from "../src/redactionSecrets.js";

// Redaction needle collection (R8.4, R15.5).
//
// This module decides WHAT gets redacted from everything the user sees. Both
// failure directions are harmful and are tested here:
//
//   • under-collection — a real credential is echoed by a tool (`env`, a stack
//     trace, a `.env` read) and rendered verbatim into the panel and log;
//   • over-collection — a common value like `true` or `production` becomes a
//     search-and-replace needle and blanks out unrelated output, making the panel
//     actively misleading.

// ---------------------------------------------------------------------------
// Name classification
// ---------------------------------------------------------------------------

describe("isCredentialName", () => {
  it("recognizes the provider credential variables the CLI actually uses", () => {
    for (const name of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "DEEPSEEK_API_KEY",
      "GOOGLE_API_KEY",
      "GEMINI_API_KEY",
      "KIMI_API_KEY",
      "RAYU_API_KEY",
      "RAYU_GATEWAY_TOKEN",
      "GITHUB_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "DATABASE_PASSWORD",
      "SERVICE_CREDENTIALS",
      "SSH_PRIVATE_KEY",
    ]) {
      expect(isCredentialName(name), `${name} should be credential-like`).toBe(
        true,
      );
    }
  });

  it("is case-insensitive", () => {
    expect(isCredentialName("anthropic_api_key")).toBe(true);
    expect(isCredentialName("Openai_Api_Key")).toBe(true);
  });

  it("does not claim ordinary configuration variables", () => {
    for (const name of [
      "PATH",
      "HOME",
      "NODE_ENV",
      "LANG",
      "TERM",
      "SHELL",
      "EDITOR",
      "PWD",
      "API_URL",
      "API_BASE_URL",
      "TOKEN_LIMIT",
      "MAX_TOKENS",
      "KEYBOARD_LAYOUT",
      "SECRETS_DIR",
    ]) {
      expect(isCredentialName(name), `${name} should NOT be credential-like`).toBe(
        false,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Value plausibility — the over-redaction guard
// ---------------------------------------------------------------------------

describe("isPlausibleSecret", () => {
  it("accepts realistic provider key shapes", () => {
    for (const value of [
      "sk-ant-api03-AbCdEf1234567890GhIjKlMnOpQrSt",
      "sk-proj-0123456789abcdefghijklmnop",
      "ghp_1234567890abcdefghijklmnopqrstuvwx",
      "AKIAIOSFODNN7EXAMPLE",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJhIjoxfQ.sig",
    ]) {
      expect(isPlausibleSecret(value), `${value} should be usable`).toBe(true);
    }
  });

  it("rejects values too short to be a credential", () => {
    // A short needle would match inside unrelated words and blank out prose.
    expect(isPlausibleSecret("abc")).toBe(false);
    expect(isPlausibleSecret("12345")).toBe(false);
    expect(isPlausibleSecret("shortkey")).toBe(false);
  });

  it("rejects booleans, numbers and known placeholders", () => {
    for (const value of [
      "true",
      "false",
      "TRUE",
      "none",
      "default",
      "changeme",
      "your-api-key",
      "1234567890123",
      "-42.5000000000",
    ]) {
      expect(isPlausibleSecret(value), `${value} should be rejected`).toBe(false);
    }
  });

  it("rejects values containing whitespace", () => {
    // A phrase would blank out ordinary sentences; and a padded value would not
    // match the text as it actually appears.
    expect(isPlausibleSecret("this is not a key")).toBe(false);
    expect(isPlausibleSecret("  sk-abcdefghijklmnop  ")).toBe(false);
    expect(isPlausibleSecret("key\twith\ttabs\there")).toBe(false);
  });

  it("rejects filesystem paths, which point AT a secret rather than being one", () => {
    for (const value of [
      "/home/user/.config/gcloud/key.json",
      "~/.ssh/id_rsa",
      "C:\\Users\\me\\keys\\service.pem",
      "/etc/ssl/private/server.key",
    ]) {
      expect(isPlausibleSecret(value), `${value} should be rejected`).toBe(false);
    }
  });

  it("rejects a bare URL but accepts one with embedded credentials", () => {
    expect(isPlausibleSecret("https://api.example.test/v1")).toBe(false);
    expect(isPlausibleSecret("postgres://localhost:5432/db")).toBe(false);
    // userinfo present ⇒ the whole URL is worth redacting.
    expect(isPlausibleSecret("postgres://user:p4ssw0rd@host:5432/db")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

describe("collectEnvironmentSecrets", () => {
  it("collects credential values and nothing else", () => {
    const secrets = collectEnvironmentSecrets({
      ANTHROPIC_API_KEY: "sk-ant-api03-REALKEY1234567890abcdef",
      OPENAI_API_KEY: "sk-proj-ANOTHERKEY1234567890",
      PATH: "/usr/bin:/bin",
      NODE_ENV: "production",
      HOME: "/home/user",
      API_URL: "https://api.example.test",
      SHELL: "/bin/bash",
    });

    expect(secrets.sort()).toEqual(
      [
        "sk-ant-api03-REALKEY1234567890abcdef",
        "sk-proj-ANOTHERKEY1234567890",
      ].sort(),
    );
  });

  it("returns values, never variable names", () => {
    const secrets = collectEnvironmentSecrets({
      ANTHROPIC_API_KEY: "sk-ant-api03-REALKEY1234567890abcdef",
    });

    expect(secrets).not.toContain("ANTHROPIC_API_KEY");
  });

  it("deduplicates a value shared by several variables", () => {
    const shared = "sk-shared-KEY1234567890abcdef";
    expect(
      collectEnvironmentSecrets({
        ANTHROPIC_API_KEY: shared,
        RAYU_API_KEY: shared,
      }),
    ).toEqual([shared]);
  });

  it("skips undefined and empty values", () => {
    expect(
      collectEnvironmentSecrets({
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: "",
        GITHUB_TOKEN: "   ",
      }),
    ).toEqual([]);
  });

  it("produces an empty set for an environment with no credentials", () => {
    expect(
      collectEnvironmentSecrets({ PATH: "/usr/bin", NODE_ENV: "test" }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the collected set actually removes the credential
// ---------------------------------------------------------------------------

describe("collected secrets fed to the Redactor (R15.5)", () => {
  it("removes an echoed credential from agent output, leaving no partial", () => {
    const key = "sk-ant-api03-REALKEY1234567890abcdef";
    const redactor = new Redactor(
      collectEnvironmentSecrets({ ANTHROPIC_API_KEY: key, PATH: "/usr/bin" }),
    );

    // The shape a `Bash` tool running `env` would put on stdout.
    const echoed = `ANTHROPIC_API_KEY=${key}\nPATH=/usr/bin`;
    const output = redactor.redact(echoed);

    expect(output).not.toContain(key);
    // Not even a masked remnant may survive (R15.5).
    expect(output).not.toContain(key.slice(-8));
    expect(output).toContain("[REDACTED]");
    // Unrelated output is untouched.
    expect(output).toContain("PATH=/usr/bin");
  });

  it("is active — hasSecrets is true — for a realistic environment", () => {
    // The bug this guards: constructed with an empty set the Redactor is a no-op
    // and `redactDeep` returns early, making the whole filter dead code.
    const redactor = new Redactor(
      collectEnvironmentSecrets({
        ANTHROPIC_API_KEY: "sk-ant-api03-REALKEY1234567890abcdef",
      }),
    );
    expect(redactor.hasSecrets).toBe(true);
  });

  it("stays inert when the environment holds no credentials", () => {
    const redactor = new Redactor(
      collectEnvironmentSecrets({ PATH: "/usr/bin", NODE_ENV: "test" }),
    );
    expect(redactor.hasSecrets).toBe(false);
    expect(redactor.redact("nothing to do here")).toBe("nothing to do here");
  });
});
