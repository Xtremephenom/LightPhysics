#!/usr/bin/env node
import { chmod, lstat, mkdir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const forbiddenPrefixes = ["docs/pack/", "master_promptpack_nottobeshipped/"];
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

class UsageError extends Error {}

function usage() {
  return `Usage: node scripts/publish-public.mjs --source-dir DIR --publisher-dir DIR --source-ref REF [--message SUBJECT] [--tag TAG] [--no-push]

Materialize REF from the source checkout into an existing clean public publisher
worktree, commit it with a Source-Commit trailer, and optionally push only
publisher HEAD to origin/main and an explicitly requested tag.`;
}

function parseArgs(argv) {
  const options = { noPush: false };
  const valueOptions = new Map([
    ["--source-dir", "sourceDir"],
    ["--publisher-dir", "publisherDir"],
    ["--source-ref", "sourceRef"],
    ["--message", "message"],
    ["--tag", "tag"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--no-push") {
      if (options.noPush) throw new UsageError("--no-push may be passed only once");
      options.noPush = true;
      continue;
    }
    const option = valueOptions.get(argument);
    if (!option) throw new UsageError(`unknown option: ${argument}`);
    if (options[option] !== undefined) throw new UsageError(`${argument} may be passed only once`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new UsageError(`${argument} requires a value`);
    options[option] = value;
    index += 1;
  }

  for (const [flag, option] of valueOptions) {
    if (option === "tag" || option === "message") continue;
    if (options[option] === undefined) throw new UsageError(`${flag} is required`);
  }
  options.message ??= "Publish public snapshot";
  if (options.message.length === 0 || options.message.length > 200 || /[\0\r\n]/u.test(options.message)) {
    throw new UsageError("--message must be 1-200 characters without newlines");
  }
  if (options.message.includes("Source-Commit:")) {
    throw new UsageError("--message must not contain a Source-Commit trailer");
  }
  if (options.sourceDir.length === 0 || options.publisherDir.length === 0) {
    throw new UsageError("repository paths must not be empty");
  }
  if (!isSafeRevision(options.sourceRef)) {
    throw new UsageError("--source-ref must be a single bounded branch, tag, or commit name");
  }
  if (options.tag !== undefined && !isSafeTag(options.tag)) {
    throw new UsageError("--tag must be a valid bounded Git tag name");
  }
  return options;
}

function isSafeRevision(value) {
  return value.length <= 256
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    && !value.includes("..")
    && !value.includes("//")
    && !value.includes("@{")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.includes("/.")
    && !value.includes("./");
}

function isSafeTag(value) {
  return value.length <= 100
    && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value)
    && !value.includes("..")
    && !value.includes("//")
    && !value.includes("@{")
    && !value.endsWith("/")
    && !value.endsWith(".")
    && !value.includes("/.")
    && !value.includes("./");
}

function gitResult(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw new Error(`could not run git: ${result.error.message}`);
  return result;
}

function git(cwd, args) {
  const result = gitResult(cwd, args);
  if (result.status !== 0) {
    const details = Buffer.concat([result.stderr ?? Buffer.alloc(0), result.stdout ?? Buffer.alloc(0)])
      .toString("utf8")
      .trim();
    throw new Error(details || `git ${args.join(" ")} exited with status ${result.status}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

function gitText(cwd, args) {
  return git(cwd, args).toString("utf8").trim();
}

function repositoryRoot(repository) {
  return path.resolve(gitText(repository, ["rev-parse", "--show-toplevel"]));
}

function samePath(left, right) {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function containsPath(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function ensureDirectory(value, label) {
  const resolved = path.resolve(value);
  return lstat(resolved).then((stats) => {
    if (!stats.isDirectory()) throw new UsageError(`${label} must be an existing directory: ${value}`);
    return realpath(resolved);
  }).catch((error) => {
    if (error instanceof UsageError) throw error;
    throw new UsageError(`${label} must be an existing directory: ${value}`);
  });
}

async function ensurePublisher(publisherDir, noPush) {
  let root;
  try {
    root = repositoryRoot(publisherDir);
  } catch (error) {
    throw new UsageError(`--publisher-dir is not a Git worktree: ${error.message}`);
  }
  if (!samePath(root, publisherDir)) {
    throw new UsageError("--publisher-dir must be the worktree root");
  }
  const inside = gitText(publisherDir, ["rev-parse", "--is-inside-work-tree"]);
  if (inside !== "true") throw new UsageError("--publisher-dir must be a worktree");
  const status = gitText(publisherDir, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored"]);
  if (status !== "") throw new UsageError("publisher worktree must be clean");
  if (!noPush) {
    try {
      const remote = gitText(publisherDir, ["remote", "get-url", "origin"]);
      if (remote.length === 0) throw new Error("empty URL");
    } catch {
      throw new UsageError("publisher repository must have an origin remote when pushing");
    }
  }
}

async function sourceCommit(sourceDir, sourceRef) {
  try {
    return gitText(sourceDir, ["rev-parse", "--verify", "--end-of-options", `${sourceRef}^{commit}`]);
  } catch (error) {
    throw new UsageError(`could not resolve --source-ref ${sourceRef}: ${error.message}`);
  }
}

function parseTree(output) {
  return output.toString("utf8").split("\0").filter(Boolean).map((entry) => {
    const separator = entry.indexOf("\t");
    if (separator < 0) throw new Error("unexpected git ls-tree output");
    const [mode, type, object] = entry.slice(0, separator).split(" ");
    const relativePath = entry.slice(separator + 1);
    if (!mode || !type || !object || relativePath.length === 0) throw new Error("invalid source tree entry");
    return { mode, type, object, relativePath };
  });
}

function assertPublicPath(relativePath) {
  if (relativePath === ".git" || relativePath.startsWith(".git/")) {
    throw new Error(`source tree contains an unsupported Git metadata path: ${relativePath}`);
  }
  if (forbiddenPrefixes.some((prefix) => relativePath.startsWith(prefix))) {
    return false;
  }
  if (relativePath.includes("\\") || relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`source tree contains an unsafe path: ${relativePath}`);
  }
  return true;
}

async function clearWorktree(publisherDir) {
  for (const entry of await readdir(publisherDir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    await rm(path.join(publisherDir, entry.name), { recursive: true, force: true });
  }
}

async function materialize(sourceDir, publisherDir, commit) {
  const entries = parseTree(git(sourceDir, ["ls-tree", "--full-tree", "-r", "-z", commit]));
  await clearWorktree(publisherDir);
  for (const entry of entries) {
    if (!assertPublicPath(entry.relativePath)) continue;
    if (entry.type !== "blob") {
      throw new Error(`source tree contains unsupported ${entry.type} entry: ${entry.relativePath}`);
    }
    const target = path.join(publisherDir, ...entry.relativePath.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    const content = git(sourceDir, ["cat-file", "blob", entry.object]);
    if (entry.mode === "120000") {
      const linkTarget = content.toString("utf8");
      try {
        await symlink(linkTarget, target);
      } catch (error) {
        if (process.platform !== "win32" || !["EPERM", "EACCES"].includes(error.code)) throw error;
        await writeFile(target, content);
      }
    } else if (entry.mode === "100644" || entry.mode === "100755") {
      await writeFile(target, content);
      if (entry.mode === "100755") await chmod(target, 0o755);
      else if (process.platform !== "win32") await chmod(target, 0o644);
    } else {
      throw new Error(`source tree contains unsupported file mode ${entry.mode}: ${entry.relativePath}`);
    }
  }
}

function runAudit(publisherDir) {
  const audit = path.join(scriptRoot, "scripts", "public-tree-audit.mjs");
  const result = spawnSync(process.execPath, [audit], {
    cwd: publisherDir,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) throw new Error(`could not run public-tree-audit: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`public-tree-audit failed:\n${(result.stdout + result.stderr).trim()}`);
  }
}

function stage(publisherDir) {
  git(publisherDir, ["add", "--all", "--force", "--", "."]);
  const result = gitResult(publisherDir, ["diff", "--cached", "--quiet", "--exit-code"]);
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(Buffer.concat([result.stderr ?? Buffer.alloc(0), result.stdout ?? Buffer.alloc(0)]).toString("utf8"));
  }
  return result.status === 1;
}

function createCommit(publisherDir, message, sourceHash) {
  git(publisherDir, ["commit", "-m", message, "-m", `Source-Commit: ${sourceHash}`]);
  return gitText(publisherDir, ["rev-parse", "HEAD"]);
}

function createTag(publisherDir, tag) {
  if (tag === undefined) return;
  git(publisherDir, ["check-ref-format", "--allow-onelevel", `refs/tags/${tag}`]);
  git(publisherDir, ["tag", tag, "HEAD"]);
}

function pushPublisher(publisherDir, tag) {
  const refs = ["HEAD:refs/heads/main"];
  if (tag !== undefined) refs.push(`refs/tags/${tag}:refs/tags/${tag}`);
  const args = ["push", "--porcelain", "--no-follow-tags", "--atomic", "origin", ...refs];
  try {
    git(publisherDir, args);
  } catch (error) {
    if (!/atomic.{0,40}(support|unsupported)|(?:support|unsupported).{0,40}atomic/iu.test(error.message)) throw error;
    git(publisherDir, ["push", "--porcelain", "--no-follow-tags", "origin", ...refs]);
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  const [sourceDir, publisherDir] = await Promise.all([
    ensureDirectory(options.sourceDir, "--source-dir"),
    ensureDirectory(options.publisherDir, "--publisher-dir"),
  ]);
  const sourceRoot = repositoryRoot(sourceDir);
  await ensurePublisher(publisherDir, options.noPush);
  if (samePath(sourceRoot, publisherDir) || containsPath(sourceRoot, publisherDir) || containsPath(publisherDir, sourceRoot)) {
    throw new UsageError("source and publisher directories must be separate and non-overlapping");
  }
  const commit = await sourceCommit(sourceDir, options.sourceRef);
  runAudit(publisherDir);
  await materialize(sourceDir, publisherDir, commit);
  const changed = stage(publisherDir);
  if (!changed) {
    createTag(publisherDir, options.tag);
    runAudit(publisherDir);
    if (!options.noPush) pushPublisher(publisherDir, options.tag);
    console.log(`publish-public: publisher already matches ${commit}; no commit created${options.noPush ? " (no push)" : ""}`);
    return;
  }
  const publisherCommit = createCommit(publisherDir, options.message, commit);
  createTag(publisherDir, options.tag);
  runAudit(publisherDir);
  if (!options.noPush) pushPublisher(publisherDir, options.tag);
  console.log(`publish-public: ${publisherCommit} published from ${commit}${options.noPush ? " (no push)" : ""}`);
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    console.error(`publish-public: ${error.message}\n\n${usage()}`);
  } else {
    console.error(`publish-public: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 1;
}
