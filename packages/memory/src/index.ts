import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export const MEMORY_LAYOUT_VERSION = 1;
export const DEFAULT_INDEX_RELATIVE = path.join("lp", "index.sqlite");
export const DEFAULT_RESUME_MAX_TOKENS = 2_500;
export const DEFAULT_RESUME_MAX_BYTES = 10_000;
const EMBEDDING_DIMENSIONS = 64;
const MAX_SOURCE_FILE_BYTES = 1_048_576;

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export type DecisionStatus = "proposed" | "approved-by-human" | "superseded";
export type WorkOrderStatus = "backlog" | "ready" | "in-progress" | "blocked" | "done";

export interface HumanChannelEvidence {
  readonly channel: "human";
  readonly verified: true;
  readonly evidenceId: string;
  readonly subject: string;
}

export interface ProjectInitResult {
  readonly root: string;
  readonly created: readonly string[];
  readonly unchanged: readonly string[];
}

export interface Decision {
  readonly id: string;
  readonly title: string;
  readonly status: DecisionStatus;
  readonly context: string;
  readonly outcome: string;
  readonly evidenceId?: string;
  readonly path: string;
}

export interface WorkOrder {
  readonly id: string;
  readonly title: string;
  readonly status: WorkOrderStatus;
  readonly priority: number;
  readonly acceptance: string;
  readonly path: string;
}

export interface ResumeBrief {
  readonly stage: string;
  readonly gateGaps: readonly string[];
  readonly topWorkOrders: readonly WorkOrder[];
  readonly pendingHumanDecisions: readonly Decision[];
  readonly staleEvidence: readonly string[];
  readonly spend: { readonly used: number; readonly budget: number; readonly currency: string };
  readonly readiness: readonly string[];
  readonly nextActions: readonly string[];
  readonly tokenEstimate: number;
  readonly byteLength: number;
}

export interface ResumeOptions {
  readonly maxTokens?: number;
  readonly maxBytes?: number;
}

export interface SearchResult {
  readonly path: string;
  readonly kind: string;
  readonly score: number;
  readonly lexicalScore: number;
  readonly semanticScore: number;
  readonly excerpt: string;
}

export class MemoryValidationError extends Error {
  readonly code = "MemoryValidationError" as const;

  constructor(message: string) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

export class MemoryConflictError extends Error {
  readonly code = "MemoryConflict" as const;

  constructor(message: string) {
    super(message);
    this.name = "MemoryConflictError";
  }
}

function fail(message: string): never {
  throw new MemoryValidationError(message);
}

function projectRoot(root: string): string {
  if (typeof root !== "string" || !root || root.includes("\0")) fail("project root is required and must not contain NUL bytes");
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) fail("project root must be a project directory, not a filesystem root");
  return resolved;
}

function relative(root: string, candidate: string): string {
  const result = path.relative(root, candidate);
  if (!result || result === ".." || result.startsWith(`..${path.sep}`) || path.isAbsolute(result)) {
    fail(`path escapes project root: ${candidate}`);
  }
  return result.split(path.sep).join("/");
}

function within(root: string, candidate: string): boolean {
  const result = path.relative(root, candidate);
  return !result || (result !== ".." && !result.startsWith(`..${path.sep}`) && !path.isAbsolute(result));
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32" ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase() : normalizedLeft === normalizedRight;
}

async function validateProjectRoot(root: string, allowMissing = false): Promise<void> {
  try {
    const details = await lstat(root);
    if (!details.isDirectory() || details.isSymbolicLink()) fail(`unsafe project root: ${root}`);
    await validateRootAncestors(root);
  } catch (error) {
    if (error instanceof MemoryValidationError) throw error;
    if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") {
      await validateRootAncestors(root);
      return;
    }
    throw new MemoryValidationError(`cannot access project root: ${root}`);
  }
}

async function validateRootAncestors(root: string): Promise<void> {
  let ancestor = path.dirname(root);
  while (true) {
    try {
      const details = await lstat(ancestor);
      if (details.isSymbolicLink()) fail(`project root resolves through a symlink: ${root}`);
      if (!details.isDirectory()) fail(`unsafe project root: ${root}`);
    } catch (error) {
      if (error instanceof MemoryValidationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new MemoryValidationError(`cannot access project root: ${root}`);
    }
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
}

function safeRelativePath(relativePath: string): string {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\0")) fail("memory path is invalid");
  const normalized = relativePath.split(path.sep).join("/");
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(relativePath)) fail(`path escapes project root: ${relativePath}`);
  if (normalized.split("/").some((part) => !part || part === "." || part === "..")) fail(`path escapes project root: ${relativePath}`);
  return normalized;
}

async function jailedPath(root: string, relativePath: string, expected: "file" | "directory" | "any" = "any"): Promise<string> {
  const safeRelative = safeRelativePath(relativePath);
  const absolute = path.resolve(root, ...safeRelative.split("/"));
  if (relative(root, absolute) !== safeRelative) fail(`path escapes project root: ${relativePath}`);
  const canonicalRoot = await realpath(root);
  let resolved: string;
  try {
    resolved = await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new MemoryValidationError(`cannot access memory path: ${safeRelative}`);
    const parent = path.dirname(absolute);
    try {
      const resolvedParent = await realpath(parent);
      if (!within(canonicalRoot, resolvedParent)) fail(`path resolves outside project root: ${safeRelative}`);
    } catch (parentError) {
      if ((parentError as NodeJS.ErrnoException).code !== "ENOENT") throw new MemoryValidationError(`cannot access memory path: ${safeRelative}`);
    }
    return absolute;
  }
  if (!samePath(canonicalRoot, resolved) && !within(canonicalRoot, resolved)) fail(`path resolves outside project root: ${safeRelative}`);
  const details = await lstat(absolute);
  if (details.isSymbolicLink()) fail(`symlink is not allowed in project memory: ${safeRelative}`);
  if (expected === "file" && !details.isFile()) fail(`memory source is not a regular file: ${safeRelative}`);
  if (expected === "directory" && !details.isDirectory()) fail(`memory path is not a directory: ${safeRelative}`);
  if (expected === "any" && !details.isFile() && !details.isDirectory()) fail(`memory path is not a regular file or directory: ${safeRelative}`);
  return absolute;
}

async function ensureDirectory(root: string, relativePath: string): Promise<string> {
  if (relativePath === "." || relativePath === "") return root;
  const safeRelative = safeRelativePath(relativePath);
  const parts = safeRelative.split("/");
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const details = await lstat(current);
      if (details.isSymbolicLink() || !details.isDirectory()) fail(`unsafe memory directory: ${safeRelative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new MemoryValidationError(`cannot access memory directory: ${safeRelative}`);
      await mkdir(current);
    }
  }
  return current;
}

async function readBoundedFile(root: string, relativePath: string): Promise<string> {
  const absolute = await jailedPath(root, relativePath, "file");
  let details;
  try { details = await stat(absolute); } catch { throw new MemoryValidationError(`cannot inspect memory source: ${relativePath}`); }
  if (details.size > MAX_SOURCE_FILE_BYTES) fail(`memory source exceeds ${MAX_SOURCE_FILE_BYTES} bytes: ${relativePath}`);
  try { return await readFile(absolute, "utf8"); } catch { throw new MemoryValidationError(`cannot read memory source: ${relativePath}`); }
}

async function safeEntries(root: string, relativeDirectory: string): Promise<string[]> {
  const directory = await jailedPath(root, relativeDirectory, "directory");
  try {
    const entries = await readdir(directory);
    for (const entry of entries) await jailedPath(root, `${relativeDirectory}/${entry}`, "any");
    return entries;
  } catch (error) {
    if (error instanceof MemoryValidationError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new MemoryValidationError(`cannot inspect memory directory: ${relativeDirectory}`);
  }
}

function safeFileName(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) fail(`${label} contains an unsafe filename`);
  return value;
}

function yamlScalar(value: string): string | number | boolean | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("\"") || trimmed.startsWith("'")) {
    const quote = trimmed[0]!;
    if (!trimmed.endsWith(quote) || trimmed.length < 2) fail("malformed YAML scalar");
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Deliberately small YAML reader for the generated, flat project metadata files. */
function parseSimpleYaml(text: string): JsonObject {
  const result: JsonObject = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (!line.includes(":")) fail("malformed YAML metadata line");
    const colon = line.indexOf(":");
    const key = line.slice(0, colon).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) fail(`unsafe YAML key: ${key}`);
    if (Object.hasOwn(result, key)) fail(`duplicate YAML key: ${key}`);
    result[key] = yamlScalar(line.slice(colon + 1));
  }
  return result;
}

function yamlText(values: Readonly<Record<string, string | number | boolean>>): string {
  return `${Object.entries(values).map(([key, value]) => `${key}: ${typeof value === "string" ? JSON.stringify(value) : String(value)}`).join("\n")}\n`;
}

function markdownFrontMatter(text: string): { meta: JsonObject; body: string } {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) return { meta: {}, body: text };
  const match = /\r?\n---\r?(?:\n|$)/.exec(text.slice(4));
  if (!match || match.index === undefined) fail("malformed markdown front matter: missing closing delimiter");
  const end = 4 + match.index;
  return { meta: parseSimpleYaml(text.slice(4, end)), body: text.slice(end + match[0].length).trim() };
}

async function ensureFile(root: string, relativePath: string, content: string, result: { created: string[]; unchanged: string[] }): Promise<void> {
  if (Buffer.byteLength(content, "utf8") > MAX_SOURCE_FILE_BYTES) fail(`memory source exceeds ${MAX_SOURCE_FILE_BYTES} bytes: ${relativePath}`);
  const absolute = await jailedPath(root, relativePath);
  try {
    const details = await lstat(absolute);
    if (!details.isFile() || details.isSymbolicLink()) fail(`memory source is not a regular file: ${relativePath}`);
    result.unchanged.push(relativePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await ensureDirectory(root, path.posix.dirname(relativePath));
    await writeFile(absolute, content, { encoding: "utf8", flag: "wx" });
    result.created.push(relativePath);
  }
}

const INIT_FILES: Readonly<Record<string, string>> = {
  "AGENTS.md": "# LightPhysics project protocol\n\nCall `lp resume` first. Consult project memory and never claim human approval without verified Human Channel evidence.\n",
  "CLAUDE.md": "See AGENTS.md for the LightPhysics project protocol.\n",
  "lp/project.yaml": yamlText({ engine: "godot", target: "desktop", stage: "pre-production", spend_used: 0, spend_budget: 0, currency: "USD" }),
  "lp/bible/pillars.md": "# Pillars\n\nRecord the non-negotiable player and project pillars here.\n",
  "lp/bible/tone.md": "# Tone\n\nRecord the intended tone here.\n",
  "lp/bible/style_lock.yaml": yamlText({ version: 0, status: "draft", name: "Initial Style Lock" }),
  "lp/bible/audio_palette.md": "# Audio Palette\n\nRecord the audio palette here.\n",
  "lp/bible/glossary.md": "# Glossary\n\nRecord canonical terms here.\n",
  "lp/quality_bar.yaml": yamlText({ version: 1, stage: "pre-production", gate_gaps: "Define measurable gates" }),
  "lp/skills.lock": "# Pinned skills\n",
};

export async function initProject(inputRoot: string): Promise<ProjectInitResult> {
  const root = projectRoot(inputRoot);
  await validateProjectRoot(root, true);
  await mkdir(root, { recursive: true });
  await validateProjectRoot(root);
  const result = { root, created: [] as string[], unchanged: [] as string[] };
  for (const [file, content] of Object.entries(INIT_FILES)) await ensureFile(root, file, content, result);
  for (const directory of ["lp/bible/characters", "lp/bible/world", "lp/bible/references", "lp/decisions", "lp/board", "lp/provenance", "lp/releases", "game", "assets_src"]) {
    await ensureDirectory(root, directory);
  }
  return result;
}

function requireHumanEvidence(evidence: HumanChannelEvidence): void {
  if (evidence.channel !== "human" || evidence.verified !== true || !evidence.evidenceId || !evidence.subject) {
    throw new MemoryValidationError("only verified Human Channel evidence can approve memory records");
  }
}

async function nextNumber(directory: string, prefix: string): Promise<number> {
  let entries: string[] = [];
  try { entries = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 1;
    throw new MemoryValidationError(`cannot inspect memory directory: ${directory}`);
  }
  let max = 0;
  for (const entry of entries) {
    const match = new RegExp(`^${prefix}-(\\d{4})-`).exec(entry);
    if (match?.[1]) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export async function createDecision(rootInput: string, input: { title: string; context?: string; outcome?: string }): Promise<Decision> {
  const root = projectRoot(rootInput);
  await validateProjectRoot(root);
  await ensureDirectory(root, "lp/decisions");
  if (!input.title.trim()) fail("decision title is required");
  const idNumber = await nextNumber(await jailedPath(root, "lp/decisions", "directory"), "D");
  const id = `D-${String(idNumber).padStart(4, "0")}`;
  const slug = safeFileName(input.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "decision"), "decision");
  const relativePath = `lp/decisions/${id}-${slug}.md`;
  const content = `---\nid: ${id}\nstatus: proposed\ntitle: ${JSON.stringify(input.title.trim())}\n---\n\n# ${input.title.trim()}\n\n## Context\n${input.context ?? ""}\n\n## Outcome\n${input.outcome ?? ""}\n`;
  await ensureFile(root, relativePath, content, { created: [], unchanged: [] });
  return { id, title: input.title.trim(), status: "proposed", context: input.context ?? "", outcome: input.outcome ?? "", path: relativePath };
}

export async function createWorkOrder(rootInput: string, input: { title: string; acceptance: string; priority?: number; status?: WorkOrderStatus }): Promise<WorkOrder> {
  const root = projectRoot(rootInput);
  await validateProjectRoot(root);
  await ensureDirectory(root, "lp/board");
  if (!input.title.trim() || !input.acceptance.trim()) fail("work-order title and acceptance are required");
  const priority = input.priority ?? 3;
  if (!Number.isInteger(priority) || priority < 1 || priority > 9) fail("work-order priority must be an integer from 1 to 9");
  const idNumber = await nextNumber(await jailedPath(root, "lp/board", "directory"), "WO");
  const id = `WO-${String(idNumber).padStart(4, "0")}`;
  const slug = safeFileName(input.title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "work-order"), "work order");
  const relativePath = `lp/board/${id}-${slug}.md`;
  const status = input.status ?? "backlog";
  const content = `---\nid: ${id}\nstatus: ${status}\npriority: ${priority}\ntitle: ${JSON.stringify(input.title.trim())}\nacceptance: ${JSON.stringify(input.acceptance.trim())}\n---\n\n# ${input.title.trim()}\n\n${input.acceptance.trim()}\n`;
  await ensureFile(root, relativePath, content, { created: [], unchanged: [] });
  return { id, title: input.title.trim(), status, priority, acceptance: input.acceptance.trim(), path: relativePath };
}

async function decisionFiles(root: string): Promise<string[]> {
  const entries = await safeEntries(root, "lp/decisions");
  for (const file of entries) {
    if (!/^D-\d{4}-[A-Za-z0-9._-]+\.md$/.test(file)) fail(`unsafe decision filename: ${file}`);
  }
  return entries.filter((file) => /^D-\d{4}-[A-Za-z0-9._-]+\.md$/.test(file)).sort();
}

export async function listDecisions(rootInput: string): Promise<Decision[]> {
  const root = projectRoot(rootInput);
  await validateProjectRoot(root);
  const result: Decision[] = [];
  for (const file of await decisionFiles(root)) {
    const relativePath = `lp/decisions/${file}`;
    const parsed = markdownFrontMatter(await readBoundedFile(root, relativePath));
    if (!parsed.meta.id || !parsed.meta.title || !parsed.meta.status) fail(`decision metadata is incomplete: ${relativePath}`);
    if (String(parsed.meta.id) !== file.slice(0, 6)) fail(`decision metadata id does not match filename: ${relativePath}`);
    if (!["proposed", "approved-by-human", "superseded"].includes(String(parsed.meta.status))) fail(`invalid decision status: ${relativePath}`);
    const id = String(parsed.meta.id ?? file.slice(0, 6));
    result.push({ id, title: String(parsed.meta.title ?? file), status: (parsed.meta.status ?? "proposed") as DecisionStatus, context: parsed.body, outcome: "", path: relativePath, ...(parsed.meta.evidence_id ? { evidenceId: String(parsed.meta.evidence_id) } : {}) });
  }
  return result;
}

export async function approveDecision(rootInput: string, id: string, evidence: HumanChannelEvidence): Promise<Decision> {
  requireHumanEvidence(evidence);
  const root = projectRoot(rootInput);
  await validateProjectRoot(root);
  const decision = (await listDecisions(root)).find((item) => item.id === id);
  if (!decision) throw new MemoryValidationError(`decision not found: ${id}`);
  if (decision.status === "approved-by-human") {
    if (decision.evidenceId === evidence.evidenceId) return decision;
    throw new MemoryConflictError(`decision is already approved by Human Channel evidence: ${id}`);
  }
  const absolute = await jailedPath(root, decision.path, "file");
  const text = await readBoundedFile(root, decision.path);
  const updated = text.replace(/^status:\s*[^\r\n]+/m, "status: approved-by-human").replace(/^(---\n)/, `$1evidence_id: ${evidence.evidenceId}\n`);
  await writeFile(absolute, updated, "utf8");
  return { ...decision, status: "approved-by-human", evidenceId: evidence.evidenceId };
}

export async function createStyleLockVersion(rootInput: string, version: number, yaml: string, evidence?: HumanChannelEvidence): Promise<string> {
  const root = projectRoot(rootInput);
  await validateProjectRoot(root);
  if (!Number.isInteger(version) || version < 1) fail("style lock version must be a positive integer");
  if (Buffer.byteLength(yaml, "utf8") > MAX_SOURCE_FILE_BYTES) fail(`memory source exceeds ${MAX_SOURCE_FILE_BYTES} bytes: style lock`);
  const relativePath = `lp/bible/style_lock.v${version}.yaml`;
  const absolute = await jailedPath(root, relativePath);
  if (evidence) requireHumanEvidence(evidence);
  try {
    const details = await lstat(absolute);
    if (details.isSymbolicLink() || !details.isFile()) fail(`memory source is not a regular file: ${relativePath}`);
    const existing = await readBoundedFile(root, relativePath);
    if (existing !== yaml) throw new MemoryConflictError(`approved Style Lock version is immutable: ${relativePath}`);
    return relativePath;
  } catch (error) {
    if (error instanceof MemoryConflictError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await ensureDirectory(root, "lp/bible");
  await writeFile(absolute, yaml, { encoding: "utf8", flag: "wx" });
  return relativePath;
}

export async function approveStyleLock(rootInput: string, version: number, evidence: HumanChannelEvidence): Promise<string> {
  requireHumanEvidence(evidence);
  const root = projectRoot(rootInput);
  await validateProjectRoot(root);
  const yaml = await readBoundedFile(root, "lp/bible/style_lock.yaml");
  const approvedYaml = `${yaml.replace(/^status:\s*[^\r\n]+/m, "status: approved").replace(/\s*$/, "\n")}evidence_id: ${evidence.evidenceId}\n`;
  const versionPath = await createStyleLockVersion(root, version, approvedYaml, evidence);
  const source = await jailedPath(root, "lp/bible/style_lock.yaml", "file");
  await writeFile(source, approvedYaml, { encoding: "utf8" });
  return versionPath;
}

async function collectSourceFiles(root: string, directory: string, found: string[]): Promise<void> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new MemoryValidationError(`cannot inspect memory directory: ${directory}`);
  }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const relativePath = relative(root, absolute);
    const details = await lstat(absolute);
    if (details.isSymbolicLink()) fail(`symlink is not allowed in project memory: ${relativePath}`);
    if (details.isDirectory()) {
      if (/\.(md|yaml|yml|json)$/i.test(entry.name)) fail(`memory source is not a regular file: ${relativePath}`);
      await collectSourceFiles(root, absolute, found);
    }
    else if (!details.isFile()) fail(`memory source is not a regular file: ${relativePath}`);
    else if (/\.(md|yaml|yml|json)$/i.test(entry.name) && !entry.name.endsWith(".sqlite")) {
      const content = await readBoundedFile(root, relativePath);
      if (/\.md$/i.test(entry.name) && (content.startsWith("---\n") || content.startsWith("---\r\n"))) markdownFrontMatter(content);
      found.push(relativePath);
    }
  }
}

function deterministicEmbed(text: string): number[] {
  const vector = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const hash = createHash("sha256").update(token).digest();
    for (let i = 0; i < 4; i++) {
      const bucket = hash[i]! % EMBEDDING_DIMENSIONS;
      vector[bucket] = (vector[bucket] ?? 0) + (hash[i + 4]! % 2 === 0 ? 1 : -1) * (1 + (hash[i + 8]! / 255));
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => value / norm);
}

function cosine(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

function configureIndex(db: DatabaseSyncType): void {
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
  db.exec("DROP TABLE IF EXISTS documents_fts; DROP TABLE IF EXISTS documents; DROP TABLE IF EXISTS index_meta;");
  db.exec("CREATE TABLE documents (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, content TEXT NOT NULL, embedding TEXT NOT NULL); CREATE VIRTUAL TABLE documents_fts USING fts5(path UNINDEXED, content, tokenize='unicode61'); CREATE TABLE index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
}

function memoryIndexError(error: unknown): never {
  if (error instanceof MemoryValidationError) throw error;
  throw new MemoryValidationError("memory index is malformed or unreadable");
}

function sourceKind(file: string): string {
  if (file.includes("/bible/")) return "bible";
  if (file.includes("/decisions/")) return "decision";
  if (file.includes("/board/")) return "work-order";
  if (file.includes("quality_bar")) return "quality-bar";
  return "project";
}

export async function reindexProject(inputRoot: string): Promise<{ readonly databasePath: string; readonly documents: number; readonly fingerprint: string }> {
  const root = projectRoot(inputRoot);
  await validateProjectRoot(root);
  await ensureDirectory(root, "lp");
  const databasePath = await jailedPath(root, DEFAULT_INDEX_RELATIVE);
  try {
    const details = await lstat(databasePath);
    if (details.isSymbolicLink() || !details.isFile()) fail(`memory index is not a regular file: ${DEFAULT_INDEX_RELATIVE}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const files: string[] = [];
  await collectSourceFiles(root, await jailedPath(root, "lp", "directory"), files);
  files.sort();
  const sources = await Promise.all(files.map(async (file) => ({ file, content: await readBoundedFile(root, file) })));
  const fingerprint = createHash("sha256").update(sources.map((source) => `${source.file}\0${source.content}`).join("\0")).digest("hex");
  let db: DatabaseSyncType | undefined;
  try {
    db = new DatabaseSync(databasePath);
    configureIndex(db);
    const insert = db.prepare("INSERT INTO documents(path, kind, content, embedding) VALUES (?, ?, ?, ?)");
    const fts = db.prepare("INSERT INTO documents_fts(rowid, path, content) VALUES (?, ?, ?)");
    for (const source of sources) {
      const result = insert.run(source.file, sourceKind(source.file), source.content, JSON.stringify(deterministicEmbed(source.content)));
      fts.run(Number(result.lastInsertRowid), source.file, source.content);
    }
    db.prepare("INSERT INTO index_meta(key, value) VALUES ('fingerprint', ?)").run(fingerprint);
    db.prepare("INSERT INTO index_meta(key, value) VALUES ('layout_version', ?)").run(String(MEMORY_LAYOUT_VERSION));
  } catch (error) {
    memoryIndexError(error);
  } finally { db?.close(); }
  return { databasePath, documents: sources.length, fingerprint };
}

function ftsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return tokens.slice(0, 16).map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

export async function searchProject(inputRoot: string, query: string, topK = 5): Promise<SearchResult[]> {
  const root = projectRoot(inputRoot);
  await validateProjectRoot(root);
  if (!query.trim()) return [];
  let databasePath = await jailedPath(root, DEFAULT_INDEX_RELATIVE);
  try {
    const details = await lstat(databasePath);
    if (details.isSymbolicLink() || !details.isFile()) fail(`memory index is not a regular file: ${DEFAULT_INDEX_RELATIVE}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await reindexProject(root);
    databasePath = await jailedPath(root, DEFAULT_INDEX_RELATIVE, "file");
  }
  let db: DatabaseSyncType;
  try { db = new DatabaseSync(databasePath); } catch (error) { memoryIndexError(error); }
  try {
    const lexical = new Map<string, number>();
    const match = ftsQuery(query);
    if (match) {
      for (const row of db.prepare("SELECT path, bm25(documents_fts) AS score FROM documents_fts WHERE documents_fts MATCH ? ORDER BY score LIMIT 100").all(match) as Array<{ path: string; score: number }>) lexical.set(row.path, 1 / (1 + Math.max(0, row.score)));
    }
    const queryVector = deterministicEmbed(query);
    const rows = db.prepare("SELECT path, kind, content, embedding FROM documents").all() as Array<{ path: string; kind: string; content: string; embedding: string }>;
    return rows.map((row) => {
      const lexicalScore = lexical.get(row.path) ?? 0;
      const semanticScore = (cosine(queryVector, JSON.parse(row.embedding) as number[]) + 1) / 2;
      return { path: row.path, kind: row.kind, lexicalScore, semanticScore, score: lexicalScore * 0.65 + semanticScore * 0.35, excerpt: row.content.replace(/\s+/g, " ").trim().slice(0, 240) };
    }).sort((left, right) => right.score - left.score || left.path.localeCompare(right.path)).slice(0, Math.max(1, Math.min(topK, 50)));
  } catch (error) {
    memoryIndexError(error);
  } finally { db.close(); }
}

async function readProjectMetadata(root: string): Promise<JsonObject> {
  try { return parseSimpleYaml(await readBoundedFile(root, "lp/project.yaml")); } catch (error) {
    if (error instanceof MemoryValidationError && (error.message.includes("cannot access") || error.message.includes("cannot inspect"))) return {};
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function readQualityBar(root: string): Promise<JsonObject> {
  try { return parseSimpleYaml(await readBoundedFile(root, "lp/quality_bar.yaml")); } catch (error) {
    if (error instanceof MemoryValidationError && (error.message.includes("cannot access") || error.message.includes("cannot inspect"))) return {};
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

async function boardFiles(root: string): Promise<string[]> {
  const entries = await safeEntries(root, "lp/board");
  for (const file of entries) {
    if (!/^WO-\d{4}-[A-Za-z0-9._-]+\.md$/.test(file)) fail(`unsafe work-order filename: ${file}`);
  }
  return entries.filter((file) => /^WO-\d{4}-[A-Za-z0-9._-]+\.md$/.test(file)).sort();
}

export async function listWorkOrders(rootInput: string): Promise<WorkOrder[]> {
  const root = projectRoot(rootInput);
  await validateProjectRoot(root);
  const result: WorkOrder[] = [];
  for (const file of await boardFiles(root)) {
    const relativePath = `lp/board/${file}`;
    const parsed = markdownFrontMatter(await readBoundedFile(root, relativePath));
    if (!parsed.meta.id || !parsed.meta.title || !parsed.meta.status || parsed.meta.priority === undefined) fail(`work-order metadata is incomplete: ${relativePath}`);
    if (String(parsed.meta.id) !== file.slice(0, 7)) fail(`work-order metadata id does not match filename: ${relativePath}`);
    if (!["backlog", "ready", "in-progress", "blocked", "done"].includes(String(parsed.meta.status))) fail(`invalid work-order status: ${relativePath}`);
    if (!Number.isInteger(Number(parsed.meta.priority)) || Number(parsed.meta.priority) < 1 || Number(parsed.meta.priority) > 9) fail(`invalid work-order priority: ${relativePath}`);
    result.push({ id: String(parsed.meta.id ?? file.slice(0, 7)), title: String(parsed.meta.title ?? file), status: (parsed.meta.status ?? "backlog") as WorkOrderStatus, priority: Number(parsed.meta.priority ?? 3), acceptance: String(parsed.meta.acceptance ?? parsed.body), path: relativePath });
  }
  return result;
}

async function staleEvidence(root: string): Promise<string[]> {
  const files: string[] = [];
  await collectSourceFiles(root, await jailedPath(root, "lp/provenance", "directory"), files);
  const stale: string[] = [];
  for (const file of files.filter((item) => item.endsWith(".json"))) {
    let data: JsonObject;
    try { data = JSON.parse(await readBoundedFile(root, file)) as JsonObject; }
    catch (error) {
      if (error instanceof MemoryValidationError) throw error;
      throw new MemoryValidationError(`malformed provenance metadata: ${file}`);
    }
    if (data.stale === true || data.status === "stale") stale.push(file);
  }
  return stale;
}

function normalizeBrief(brief: Omit<ResumeBrief, "tokenEstimate" | "byteLength">, options: ResumeOptions): ResumeBrief {
  const maxTokens = options.maxTokens ?? DEFAULT_RESUME_MAX_TOKENS;
  const maxBytes = options.maxBytes ?? DEFAULT_RESUME_MAX_BYTES;
  if (!Number.isInteger(maxTokens) || maxTokens < 64 || !Number.isInteger(maxBytes) || maxBytes < 256) fail("resume budgets are too small or invalid");
  const trim = (value: string, max: number): string => value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value;
  const compact = (candidate: Omit<ResumeBrief, "tokenEstimate" | "byteLength">): string => JSON.stringify(candidate);
  let current = { ...brief };
  while (Buffer.byteLength(compact(current), "utf8") > Math.min(maxBytes, maxTokens * 4) && (current.topWorkOrders.length || current.gateGaps.length || current.nextActions.length || current.readiness.length || current.staleEvidence.length)) {
    if (current.topWorkOrders.length) current = { ...current, topWorkOrders: current.topWorkOrders.slice(0, -1) };
    else if (current.nextActions.length) current = { ...current, nextActions: current.nextActions.slice(0, -1) };
    else if (current.gateGaps.length) current = { ...current, gateGaps: current.gateGaps.slice(0, -1) };
    else if (current.readiness.length) current = { ...current, readiness: current.readiness.slice(0, -1) };
    else current = { ...current, staleEvidence: current.staleEvidence.slice(0, -1) };
  }
  const text = compact(current);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > maxBytes || Math.ceil(bytes / 4) > maxTokens) throw new MemoryValidationError("resume brief cannot fit requested budget while retaining required fields");
  return { ...current, tokenEstimate: Math.ceil(bytes / 4), byteLength: bytes };
}

export async function projectResume(inputRoot: string, options: ResumeOptions = {}): Promise<ResumeBrief> {
  const root = projectRoot(inputRoot);
  await validateProjectRoot(root);
  const metadata = await readProjectMetadata(root);
  const quality = await readQualityBar(root);
  const decisions = await listDecisions(root);
  const workOrders = await listWorkOrders(root);
  const gaps = String(quality.gate_gaps ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const pending = decisions.filter((decision) => decision.status === "proposed");
  const stale = await staleEvidence(root);
  const active = workOrders.filter((item) => item.status !== "done").sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  const readiness = [metadata.engine ? `engine: ${String(metadata.engine)}` : "engine: unspecified", quality.version ? `quality bar v${String(quality.version)}` : "quality bar: present"];
  const nextActions = [
    ...(pending.length ? [`resolve ${pending.length} pending human decision${pending.length === 1 ? "" : "s"}`] : []),
    ...(gaps.length ? ["close quality-bar gate gaps"] : []),
    ...(active.length ? [`continue ${active[0]?.id ?? "top work order"}`] : []),
  ];
  return normalizeBrief({ stage: String(metadata.stage ?? "unspecified"), gateGaps: gaps, topWorkOrders: active.slice(0, 10), pendingHumanDecisions: pending.slice(0, 10), staleEvidence: stale, spend: { used: Number(metadata.spend_used ?? 0), budget: Number(metadata.spend_budget ?? 0), currency: String(metadata.currency ?? "USD") }, readiness, nextActions: nextActions.length ? nextActions : ["review project memory and define the next work order"] }, options);
}

export function renderResumeBrief(brief: ResumeBrief): string {
  const { tokenEstimate: _tokens, byteLength: _bytes, ...content } = brief;
  return JSON.stringify(content, null, 2);
}

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}
