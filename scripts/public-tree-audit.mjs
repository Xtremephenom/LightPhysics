#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

const forbiddenPrefixes = [
  "docs/pack/",
  "master_promptpack_nottobeshipped/",
];

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`could not run git: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const details = Buffer.concat([result.stderr, result.stdout]).toString("utf8").trim();
    throw new Error(details || `git ${args.join(" ")} exited with status ${result.status}`);
  }
  return result.stdout;
}

function findRepositoryRoot() {
  return path.resolve(runGit(["rev-parse", "--show-toplevel"], process.cwd()).toString("utf8").trim());
}

function listRefs(repositoryRoot) {
  const refs = runGit(["for-each-ref", "--format=%(refname)"], repositoryRoot)
    .toString("utf8")
    .split(/\r?\n/)
    .filter(Boolean);

  // HEAD is a reachable ref even when it is detached and therefore absent from
  // for-each-ref. An unborn HEAD has no tree to inspect, so it is skipped.
  const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "buffer",
    windowsHide: true,
  });
  const symbolicHead = spawnSync("git", ["symbolic-ref", "--quiet", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "buffer",
    windowsHide: true,
  });
  if (head.status === 0 && symbolicHead.status !== 0) refs.unshift("HEAD");
  return refs;
}

function forbiddenPathsForRef(repositoryRoot, ref) {
  const paths = runGit(["ls-tree", "--full-tree", "-r", "--name-only", "-z", ref], repositoryRoot)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  return paths.filter((filePath) => forbiddenPrefixes.some((prefix) => filePath.startsWith(prefix)));
}

try {
  const repositoryRoot = findRepositoryRoot();
  const refs = listRefs(repositoryRoot);
  const findings = [];

  for (const ref of refs) {
    for (const filePath of forbiddenPathsForRef(repositoryRoot, ref)) {
      findings.push(`${ref}:${filePath}`);
    }
  }

  if (findings.length > 0) {
    console.error("public-tree-audit: forbidden publication paths found:");
    for (const finding of findings) console.error(`  ${finding}`);
    process.exitCode = 1;
  } else {
    console.log(`public-tree-audit: clean (checked ${refs.length} ref${refs.length === 1 ? "" : "s"})`);
  }
} catch (error) {
  console.error(`public-tree-audit: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
