import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";

import { requestGateway, type GatewayResponse } from "./client.js";

const SKILLS_PATH = "/v1/skills";
export const SKILL_PROBE_TIMEOUT_MS = 5_000;
export const SKILL_CALL_TIMEOUT_MS = 45_000;
const READ_UNAVAILABLE = "Eragon Skills are unavailable on this server or for this key.";
const WRITE_UNAVAILABLE = "Eragon skill proposals are unavailable on this server or for this key.";

const NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$";
const NAME_MAX = 100;
const DESCRIPTION_MAX = 500;
const BODY_MAX_BYTES = 64 * 1024;
const REASON_MAX = 2_000;
const FILES_MAX = 50;
const FILES_MAX_BYTES = 1024 * 1024;
const PROPOSAL_MAX_BYTES = 2 * 1024 * 1024;
const NAME_REGEX = new RegExp(NAME_PATTERN);

const fileSchema = {
  type: "array",
  maxItems: FILES_MAX,
  items: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  },
  description: "Optional text files by bundle-relative path, up to 1 MiB combined.",
};

const draftFields = {
  body: { type: "string", minLength: 1, description: "Complete SKILL.md text, up to 64 KiB. Eragon adds frontmatter if absent." },
  reason: { type: "string", minLength: 1, maxLength: REASON_MAX, description: "Why the proposed change should be reviewed." },
};

export const SKILL_TOOLS: Tool[] = [
  {
    name: "skill_list",
    description: "Check Eragon Skills before redoing a known procedure. A truncated list covers the first 500 skills by name.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Filter names and descriptions." } },
      additionalProperties: false,
    },
  },
  {
    name: "skill_get",
    description: "Read SKILL.md as body and list companion files by skill name or ID, or fetch one text file by path.",
    inputSchema: {
      type: "object",
      properties: {
        idOrName: { type: "string" },
        path: { type: "string", description: "Bundle-relative path from the skill's file list." },
      },
      required: ["idOrName"],
      additionalProperties: false,
    },
  },
  {
    name: "skill_propose",
    description: "Propose a new reusable procedure. Tell the user to review and publish it on Skills → Installed at the returned reviewUrl.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", pattern: NAME_PATTERN, maxLength: NAME_MAX, description: "Kebab-case, such as release-notes." },
        description: { type: "string", maxLength: DESCRIPTION_MAX },
        ...draftFields,
        files: fileSchema,
      },
      required: ["name", "description", "body", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "skill_revise",
    description: "Propose a body revision to a skill you improved, using its ID and version from skill_get. Tell the user to review the diff and accept it on Skills → Installed at the returned reviewUrl.",
    inputSchema: {
      type: "object",
      properties: { skillId: { type: "string" }, baseVersion: { type: "integer", minimum: 0 }, ...draftFields },
      required: ["skillId", "baseVersion", "body", "reason"],
      additionalProperties: false,
    },
  },
];

export const SKILL_TOOL_NAMES = new Set(SKILL_TOOLS.map(({ name }) => name));

const isWriter = (name: string) => name === "skill_propose" || name === "skill_revise";
const READ_TOOLS = SKILL_TOOLS.filter(({ name }) => !isWriter(name));

type SkillConfig = {
  gatewayUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const validSegment = (part: string) => part !== "" && part !== "." && part !== "..";

const isFilePath = (value: unknown): value is string =>
  nonEmpty(value) && !value.includes("\\") && value.split("/").every(validSegment);

const isProposalFile = (file: unknown): file is { path: string; content: string } =>
  isRecord(file) && isFilePath(file.path) && typeof file.content === "string";

const textResult = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });

function errorResult(message: string): CallToolResult {
  return { ...textResult(message.replace(/\s+/g, " ").trim()), isError: true };
}

function skillList(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.skills)) return undefined;
  const skills: unknown[] = body.skills;
  const isSummary = (skill: unknown): skill is Record<string, unknown> & { name: string; description: string } =>
    isRecord(skill) && typeof skill.name === "string" && typeof skill.description === "string";
  if (!skills.every(isSummary)) return undefined;
  return { skills, ...(body.truncated === true ? { truncated: true } : {}) };
}

function isUnknownRoute({ status, body }: GatewayResponse): boolean {
  return status === 404 && isRecord(body) && isRecord(body.error) && body.error.type === "not_found_error";
}

export async function probeSkills(config: SkillConfig, timeoutMs = SKILL_PROBE_TIMEOUT_MS): Promise<"available" | "absent" | "unknown"> {
  if (timeoutMs <= 0) return "unknown";
  let timer: NodeJS.Timeout | undefined;
  try {
    // A Flux launcher may re-read its key before passing the abort signal on to fetch.
    const response = await Promise.race([
      requestGateway({ ...config, path: SKILLS_PATH, method: "GET", timeoutMs }),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
    ]);
    if (response?.status === 200 && skillList(response.body) !== undefined) return "available";
    return response !== undefined && isUnknownRoute(response) ? "absent" : "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

export function createSkillSession(onToolsChanged: () => void) {
  let readsUnavailable = false;
  let writesUnavailable = false;
  let advertised: Tool[] = [];
  let readRefusals = 0;

  const unavailable = (route: "read" | "write") => {
    const previouslyAdvertised = advertised;
    if (route === "read") {
      readsUnavailable = true;
      writesUnavailable = false;
      readRefusals += 1;
      advertised = [];
    } else if (!readsUnavailable) {
      writesUnavailable = true;
      if (advertised === SKILL_TOOLS) advertised = READ_TOOLS;
    }
    if (previouslyAdvertised.length !== advertised.length) onToolsChanged();
    return textResult(route === "read" ? READ_UNAVAILABLE : WRITE_UNAVAILABLE);
  };

  return {
    async list(config: SkillConfig, timeoutMs?: number): Promise<Tool[]> {
      const refusalsAtStart = readRefusals;
      const outcome = await probeSkills(config, timeoutMs);
      if (outcome === "absent") {
        readsUnavailable = true;
        writesUnavailable = false;
        readRefusals += 1;
      } else if (outcome === "available" && refusalsAtStart === readRefusals) {
        // An older successful probe must not undo an intervening read refusal.
        readsUnavailable = false;
      }
      advertised = outcome === "available" && !readsUnavailable ? (writesUnavailable ? READ_TOOLS : SKILL_TOOLS) : [];
      return advertised;
    },
    async call(name: string, args: Record<string, unknown>, config: SkillConfig, deadline?: number): Promise<CallToolResult> {
      if (readsUnavailable) return textResult(READ_UNAVAILABLE);
      if (writesUnavailable && isWriter(name)) return textResult(WRITE_UNAVAILABLE);
      return callSkillTool(name, args, config, unavailable, deadline);
    },
  };
}

function gatewayError(
  response: GatewayResponse,
  route: "read" | "write",
  onUnavailable: (route: "read" | "write") => CallToolResult,
): CallToolResult {
  if (isUnknownRoute(response)) return onUnavailable(route);
  const body = isRecord(response.body) ? response.body : {};
  const version = typeof body.currentVersion === "number" ? ` Current version is ${body.currentVersion}.` : "";
  let message: string;
  switch (body.error) {
    case "skill_not_found":
      message = "Eragon could not find that skill or file. Use skill_list or skill_get to check the name, ID, or path.";
      break;
    case "skill_version_conflict":
      message = `The skill version changed.${version} Call skill_get again, reconcile your changes, and retry skill_revise once.`;
      break;
    case "skill_name_taken":
      message = "A published skill already uses that name. Use skill_get to see it or choose another name.";
      break;
    case "skill_name_proposed":
      message = "A proposal for that skill name is already waiting for review on Skills → Installed.";
      break;
    case "invalid_proposal":
      message = "Eragon rejected the skill proposal. Check the name, fields, and size limits.";
      break;
    case "key_owner_unavailable":
      message = "Eragon could not identify an owner for this key. Ask the user to check their Flux key.";
      break;
    case "skills_unavailable":
      message = "Eragon Skills are temporarily unavailable. Try again shortly.";
      break;
    case "skill_file_too_large":
      message = typeof body.bytes === "number" && typeof body.maxBytes === "number"
        ? `This skill file is ${body.bytes} bytes and exceeds the ${body.maxBytes}-byte read limit.`
        : "This skill file exceeds the 256 KiB read limit.";
      break;
    case "skill_file_not_text":
      message = "This skill file is binary. Open it in Eragon.";
      break;
    case "skill_revision_unchanged":
      message = `The revision matches the published skill.${version} Submit a revision only when the body changes.`;
      break;
    case "skill_revision_waiting":
      message = "A change to this skill is already waiting for review on Skills → Installed.";
      break;
    case "skill_cannot_be_revised":
      message = "This skill cannot be revised with the current Eragon key.";
      break;
    case "revision_files_unsupported":
      message = "Skill revisions accept only SKILL.md changes. Remove files and submit the updated body.";
      break;
    default:
      message = `Eragon Skills request failed (HTTP ${response.status}).`;
  }
  return errorResult(nonEmpty(body.message) ? `${message} ${body.message}` : message);
}

function validSkillId(value: unknown): value is string {
  return nonEmpty(value) && validSegment(value.trim()) && !value.includes("/") && !value.includes("\\");
}

function isSkillDetail(value: unknown): value is Record<string, unknown> & { id: string; name: string; description: string } {
  return isRecord(value) && nonEmpty(value.id) && nonEmpty(value.name) && typeof value.description === "string" &&
    Number.isSafeInteger(value.version) && typeof value.body === "string" && Array.isArray(value.files);
}

async function callSkillTool(
  name: string,
  args: Record<string, unknown>,
  config: SkillConfig,
  onUnavailable: (route: "read" | "write") => CallToolResult,
  deadline = Date.now() + SKILL_CALL_TIMEOUT_MS,
): Promise<CallToolResult> {
  let submitting = false;
  const get = (path: string, responseType?: "text") =>
    requestGateway({
      ...config,
      path,
      method: "GET",
      timeoutMs: Math.max(0, deadline - Date.now()),
      ...(responseType === undefined ? {} : { responseType }),
    });
  try {
    if (name === "skill_list") {
      const { query } = args;
      if (query !== undefined && typeof query !== "string") return errorResult("skill_list query must be a string.");
      const response = await get(SKILLS_PATH);
      if (response.status !== 200) return gatewayError(response, "read", onUnavailable);
      const list = skillList(response.body);
      if (list === undefined) return errorResult("Eragon returned an invalid skill list.");
      const term = query?.trim().toLowerCase() ?? "";
      return textResult(JSON.stringify({
        ...list,
        skills: list.skills.filter((skill) =>
          skill.name.toLowerCase().includes(term) || skill.description.toLowerCase().includes(term)),
      }, null, 2));
    }
    if (name === "skill_get") {
      const { idOrName, path } = args;
      if (!validSkillId(idOrName)) return errorResult("skill_get requires an ID or name.");
      if (path !== undefined && !isFilePath(path)) return errorResult("skill_get path must be a bundle-relative file path.");
      const skill = `${SKILLS_PATH}/${encodeURIComponent(idOrName.trim())}`;
      const response = path === undefined
        ? await get(skill)
        : await get(`${skill}/files/${path.split("/").map(encodeURIComponent).join("/")}`, "text");
      if (response.status !== 200) return gatewayError(response, "read", onUnavailable);
      if (path !== undefined) return textResult(String(response.body));
      if (!isSkillDetail(response.body)) return errorResult("Eragon returned invalid skill metadata.");
      return textResult(JSON.stringify(response.body, null, 2));
    }
    if (name !== "skill_propose" && name !== "skill_revise") return errorResult(`Unknown Eragon Skills tool: ${name}`);

    const { body, files, reason } = args;
    if (!nonEmpty(body) || !nonEmpty(reason)) return errorResult(`${name} requires a body and reason.`);
    if (Buffer.byteLength(body) > BODY_MAX_BYTES) return errorResult("The skill body must be at most 64 KiB of UTF-8 text.");
    if (reason.length > REASON_MAX) return errorResult(`The proposal reason must be at most ${REASON_MAX} characters.`);
    let proposal: Record<string, unknown>;
    if (name === "skill_propose") {
      const { name: skillName, description } = args;
      if (typeof skillName !== "string" || skillName.length > NAME_MAX || !NAME_REGEX.test(skillName)) {
        return errorResult(`The skill name must be kebab-case with at most ${NAME_MAX} characters, such as release-notes.`);
      }
      if (typeof description !== "string" || description.length > DESCRIPTION_MAX) {
        return errorResult(`The skill description must be a string of at most ${DESCRIPTION_MAX} characters.`);
      }
      proposal = { name: skillName, description, body, reason };
      if (files !== undefined) {
        if (!Array.isArray(files) || files.length > FILES_MAX || !files.every(isProposalFile)) {
          return errorResult(`Provide at most ${FILES_MAX} files with bundle-relative paths and text content.`);
        }
        if (files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0) > FILES_MAX_BYTES) {
          return errorResult("The proposed files must total at most 1 MiB of UTF-8 text.");
        }
        proposal.files = files.map(({ path, content }) => ({ path, content }));
      }
    } else {
      if (files !== undefined) return errorResult("skill_revise accepts only SKILL.md changes. Remove files and submit the updated body.");
      const { skillId, baseVersion } = args;
      if (!validSkillId(skillId) || typeof baseVersion !== "number" || !Number.isSafeInteger(baseVersion) || baseVersion < 0) {
        return errorResult("skill_revise requires a skillId and an integer baseVersion from skill_get.");
      }
      const id = skillId.trim();
      // The proposal endpoint needs the published name and description even for a revision.
      const response = await get(`${SKILLS_PATH}/${encodeURIComponent(id)}`);
      if (response.status !== 200) return gatewayError(response, "read", onUnavailable);
      const skill = response.body;
      if (!isSkillDetail(skill) || skill.id !== id) {
        return errorResult("Eragon returned invalid skill metadata. Use the skill ID from skill_get.");
      }
      proposal = { name: skill.name, description: skill.description, body, reason, baseSkillId: id, baseVersion };
    }
    if (Buffer.byteLength(JSON.stringify(proposal)) > PROPOSAL_MAX_BYTES) {
      return errorResult("The JSON skill proposal must be at most 2 MiB.");
    }
    submitting = true;
    const response = await requestGateway({
      ...config,
      path: `${SKILLS_PATH}/proposals`,
      body: proposal,
      timeoutMs: Math.max(0, deadline - Date.now()),
      retryOnNetworkError: name === "skill_propose",
    });
    if (response.status !== 201) return gatewayError(response, "write", onUnavailable);
    const receipt = response.body;
    const kind = name === "skill_propose" ? "skill" : "revision";
    if (
      !isRecord(receipt) || receipt.status !== "proposed" || receipt.kind !== kind ||
      !nonEmpty(receipt.skillId) || receipt.proposalId !== receipt.skillId || !nonEmpty(receipt.reviewUrl) ||
      (kind === "revision" && (receipt.skillId !== proposal.baseSkillId || receipt.baseVersion !== proposal.baseVersion))
    ) {
      return errorResult("Eragon did not return a valid proposal receipt. Check Skills → Installed before submitting again.");
    }
    return textResult(JSON.stringify(receipt, null, 2));
  } catch {
    return errorResult(submitting
      ? "Could not confirm the Eragon skill proposal. Check Skills → Installed before submitting again."
      : "Could not read Eragon Skills. Try again.");
  }
}
