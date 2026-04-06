/**
 * Publishing readiness tests for @robot-resources/router-mcp.
 *
 * Validates package.json fields, build output, bin entry,
 * and npm pack --dry-run before publishing.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const PKG_DIR = path.resolve(__dirname, "..");
const pkg = JSON.parse(
  fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8"),
);

describe("Publishing Readiness", () => {
  // ---------------------------------------------------------------
  // package.json fields
  // ---------------------------------------------------------------

  it("has required package.json fields", () => {
    expect(pkg.name).toBe("@robot-resources/router-mcp");
    expect(pkg.version).toBeDefined();
    expect(pkg.description).toBeDefined();
    expect(pkg.license).toBe("MIT");
    expect(pkg.bin).toBeDefined();
    expect(pkg.files).toBeDefined();
    expect(pkg.engines).toBeDefined();
  });

  it("has keywords for npm discovery", () => {
    expect(pkg.keywords).toBeDefined();
    expect(pkg.keywords.length).toBeGreaterThanOrEqual(3);
    expect(pkg.keywords).toContain("mcp");
  });

  it("has prepublishOnly script", () => {
    expect(pkg.scripts.prepublishOnly).toBeDefined();
    expect(pkg.scripts.prepublishOnly).toContain("build");
    expect(pkg.scripts.prepublishOnly).toContain("test");
  });

  it("bin entry points to build/index.js", () => {
    expect(pkg.bin["router-mcp"]).toBe("./build/index.js");
  });

  it("files array includes build and README", () => {
    expect(pkg.files).toContain("build");
    expect(pkg.files).toContain("README.md");
  });

  // ---------------------------------------------------------------
  // Build output
  // ---------------------------------------------------------------

  it("build/index.js exists and has shebang", () => {
    const buildPath = path.join(PKG_DIR, "build", "index.js");
    expect(fs.existsSync(buildPath)).toBe(true);

    const content = fs.readFileSync(buildPath, "utf8");
    expect(content.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  it("build/index.js is executable", () => {
    const buildPath = path.join(PKG_DIR, "build", "index.js");
    const stat = fs.statSync(buildPath);
    // Check owner execute bit (0o100)
    expect(stat.mode & 0o100).toBeTruthy();
  });

  it("TypeScript compiles clean", () => {
    const result = execSync("npm run build", {
      cwd: PKG_DIR,
      encoding: "utf8",
      timeout: 15_000,
    });
    // tsc exits 0 if clean — no assertion on output needed
    expect(true).toBe(true);
  }, 20_000);

  // ---------------------------------------------------------------
  // npm pack
  // ---------------------------------------------------------------

  it("npm pack --dry-run succeeds and lists expected files", () => {
    const result = execSync("npm pack --dry-run 2>&1", {
      cwd: PKG_DIR,
      encoding: "utf8",
      timeout: 15_000,
    });

    // Should include build output
    expect(result).toContain("build/index.js");
    // Should include README
    expect(result).toContain("README.md");
    // Should NOT include test files
    expect(result).not.toContain("tests/");
    expect(result).not.toContain("e2e.test");
    // Should NOT include source files
    expect(result).not.toContain("src/");
  }, 20_000);
});
