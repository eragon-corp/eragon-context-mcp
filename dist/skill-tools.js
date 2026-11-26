import { requestGateway } from "./client.js";
const SKILLS_PATH = "/v1/skills";
export const SKILL_PROBE_TIMEOUT_MS = 5_000;
export const SKILL_CALL_TIMEOUT_MS = 45_000;
const PROBE_BACKOFF_MS = [2_000, 10_000, 60_000];
const MAX_TIMER_MS = 2 ** 31 - 1;
const READ_UNAVAILABLE = "Eragon Skills are unavailable on this server or for this key.";
const WRITE_UNAVAILABLE = "This key needs Memory write-back to propose Eragon skills, or this server does not accept proposals. " +
    "The proposal tools return automatically on the next tool listing. Retry once the key and server allow proposals.";
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
export const SKILL_TOOLS = [
    {
        name: "skill_list",
        description: "Check Eragon Skills before redoing a known procedure. A truncated list covers the first 500 skills by name.",
        inputSchema: {
            type: "object",
            properties: {
                query: {
                    type: "string",
                    description: "Match every query word against the combined name and description, ignoring case. Hyphens, underscores, and whitespace separate words.",
                },
            },
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
                description: { type: "string", minLength: 1, maxLength: DESCRIPTION_MAX },
                ...draftFields,
                files: fileSchema,
            },
            required: ["name", "description", "body", "reason"],
            additionalProperties: false,
        },
    },
    {
        name: "skill_revise",
        description: "Propose a body-only revision to a skill you improved, using its ID and version from skill_get. Tell the user to review the diff and accept it on Skills → Installed at the returned reviewUrl.",
        inputSchema: {
            type: "object",
            properties: {
                skillId: { type: "string" },
                baseVersion: { type: "integer", minimum: 1 },
                ...draftFields,
            },
            required: ["skillId", "baseVersion", "body", "reason"],
            additionalProperties: false,
        },
    },
];
export const SKILL_TOOL_NAMES = new Set(SKILL_TOOLS.map(({ name }) => name));
const isWriter = (name) => name === "skill_propose" || name === "skill_revise";
const READ_TOOLS = SKILL_TOOLS.filter(({ name }) => !isWriter(name));
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value.trim() !== "";
const validSegment = (part) => part !== "" && part !== "." && part !== "..";
const isFilePath = (value) => nonEmpty(value) && !value.includes("\\") && !value.includes("\0") && value.split("/").every(validSegment);
const isProposalFile = (file) => isRecord(file) && isFilePath(file.path) && file.path.length <= 500 && typeof file.content === "string";
const textResult = (text) => ({ content: [{ type: "text", text }] });
function errorResult(message) {
    return { ...textResult(message.replace(/\s+/g, " ").trim()), isError: true };
}
function skillList(body) {
    if (!isRecord(body) || !Array.isArray(body.skills))
        return undefined;
    const skills = body.skills;
    const isSummary = (skill) => isRecord(skill) && typeof skill.name === "string" && typeof skill.description === "string";
    if (!skills.every(isSummary))
        return undefined;
    return { skills, ...(body.truncated === true ? { truncated: true } : {}) };
}
function isUnknownRoute({ status, body }) {
    return status === 404 && isRecord(body) && isRecord(body.error) &&
        body.error.type === "not_found_error" && body.error.message === "unknown gateway path";
}
const retryProbe = { kind: "unknown", retry: true };
export async function probeSkills(config, timeoutMs = SKILL_PROBE_TIMEOUT_MS) {
    if (timeoutMs <= 0)
        return retryProbe;
    let timer;
    try {
        // A Flux launcher may re-read its key before passing the abort signal on to fetch.
        const response = await Promise.race([
            requestGateway({ ...config, path: SKILLS_PATH, method: "GET", timeoutMs }),
            new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs); }),
        ]);
        if (response === undefined)
            return retryProbe;
        if (response.status === 200 && skillList(response.body) !== undefined)
            return { kind: "available" };
        if (isUnknownRoute(response))
            return { kind: "absent" };
        if (response.status === 429 || response.status >= 500) {
            return {
                ...retryProbe,
                ...(response.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: response.retryAfterSeconds }),
            };
        }
        return { kind: "unknown", retry: false };
    }
    catch {
        return retryProbe;
    }
    finally {
        clearTimeout(timer);
    }
}
export function createSkillSession(onToolsChanged) {
    let readState = "unknown";
    const noTools = [];
    let advertised;
    let readRefusals = 0;
    let inFlight;
    let retryTimer;
    let retryStep = 0;
    let retryNotBefore = 0;
    let closed = false;
    const visibleTools = () => readState === "available" ? SKILL_TOOLS : noTools;
    const notify = (visible) => {
        if (closed || advertised === undefined || advertised === visible)
            return;
        advertised = visible;
        onToolsChanged();
    };
    const resetRetry = () => {
        clearTimeout(retryTimer);
        retryStep = 0;
        retryNotBefore = 0;
    };
    const markAbsent = () => {
        readState = "absent";
        readRefusals += 1;
        resetRetry();
    };
    function scheduleRetry(config, retryAfterSeconds = 0) {
        clearTimeout(retryTimer);
        const now = Date.now();
        retryNotBefore = now + retryAfterSeconds * 1_000;
        const retryAt = Math.max(retryNotBefore, now + (PROBE_BACKOFF_MS[retryStep] ?? PROBE_BACKOFF_MS[2]));
        retryStep = Math.min(retryStep + 1, PROBE_BACKOFF_MS.length - 1);
        const wake = () => {
            const remaining = retryAt - Date.now();
            if (remaining > 0) {
                retryTimer = setTimeout(wake, Math.min(remaining, MAX_TIMER_MS));
                retryTimer.unref();
            }
            else if (!closed) {
                void refresh(config, SKILL_PROBE_TIMEOUT_MS).then(() => notify(visibleTools()));
            }
        };
        wake();
    }
    function refresh(config, timeoutMs, firstList = false) {
        if (inFlight !== undefined)
            return inFlight;
        const refusalsAtStart = readRefusals;
        const deadline = Date.now() + timeoutMs;
        inFlight = (async () => {
            let outcome = await probeSkills(config, timeoutMs);
            if (closed || refusalsAtStart !== readRefusals)
                return;
            // Give clients that only list at startup one more chance within the original deadline.
            if (firstList && outcome.kind === "unknown" && outcome.retry) {
                const delay = (outcome.retryAfterSeconds ?? 0) * 1_000;
                if (delay < deadline - Date.now()) {
                    if (delay > 0)
                        await new Promise((resolve) => { setTimeout(() => resolve(), delay).unref(); });
                    if (closed || refusalsAtStart !== readRefusals)
                        return;
                    outcome = await probeSkills(config, deadline - Date.now());
                    if (closed || refusalsAtStart !== readRefusals)
                        return;
                }
            }
            switch (outcome.kind) {
                case "available":
                    readState = "available";
                    resetRetry();
                    break;
                case "absent":
                    markAbsent();
                    break;
                case "unknown":
                    if (outcome.retry)
                        scheduleRetry(config, outcome.retryAfterSeconds);
                    else
                        resetRetry();
                    break;
            }
        })().finally(() => { inFlight = undefined; });
        return inFlight;
    }
    const unavailable = (route) => {
        if (route === "read") {
            markAbsent();
            notify(noTools);
            return textResult(READ_UNAVAILABLE);
        }
        // A proposal refusal only changes the tools already advertised in this session.
        if (readState === "available")
            notify(READ_TOOLS);
        return textResult(WRITE_UNAVAILABLE);
    };
    return {
        async list(config, timeoutMs = SKILL_PROBE_TIMEOUT_MS) {
            if (Date.now() >= retryNotBefore)
                await refresh(config, timeoutMs, advertised === undefined);
            advertised = visibleTools();
            return advertised;
        },
        async call(name, args, config, deadline) {
            if (readState === "absent")
                return textResult(READ_UNAVAILABLE);
            return callSkillTool(name, args, config, unavailable, deadline);
        },
        close() {
            closed = true;
            resetRetry();
        },
    };
}
function gatewayError(response, route, onUnavailable) {
    if (isUnknownRoute(response))
        return onUnavailable(route);
    const body = isRecord(response.body) ? response.body : {};
    const version = typeof body.currentVersion === "number" ? ` Current version is ${body.currentVersion}.` : "";
    let message;
    switch (body.error) {
        case "skill_not_found":
            message = "Eragon could not find that skill or file. Use skill_list or skill_get to check the name, ID, or path.";
            break;
        case "skill_version_conflict":
            message = `The skill version changed.${version} Call skill_get again, reconcile your changes, and retry skill_revise once.`;
            break;
        case "skill_name_taken":
            message = "A skill already uses that name. Your earlier proposal may still be waiting for review on Skills → Installed. Check there before proposing under another name.";
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
            message = "Another change to this skill is being applied. Call skill_get after it lands, then retry skill_revise.";
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
    const detail = nonEmpty(body.message) ? body.message : isRecord(body.error) ? body.error.message : undefined;
    return errorResult(nonEmpty(detail) ? `${message} ${detail}` : message);
}
function validSkillId(value) {
    return nonEmpty(value) && validSegment(value.trim()) && !value.includes("/") && !value.includes("\\");
}
function isSkillDetail(value) {
    return isRecord(value) && nonEmpty(value.id) && nonEmpty(value.name) && typeof value.description === "string" &&
        Number.isSafeInteger(value.version) && typeof value.body === "string" && Array.isArray(value.files);
}
async function callSkillTool(name, args, config, onUnavailable, deadline = Date.now() + SKILL_CALL_TIMEOUT_MS) {
    let submitting = false;
    const get = (path, responseType) => requestGateway({
        ...config,
        path,
        method: "GET",
        timeoutMs: Math.max(0, deadline - Date.now()),
        ...(responseType === undefined ? {} : { responseType }),
    });
    try {
        if (name === "skill_list") {
            const { query } = args;
            if (query !== undefined && typeof query !== "string")
                return errorResult("skill_list query must be a string.");
            const response = await get(SKILLS_PATH);
            if (response.status !== 200)
                return gatewayError(response, "read", onUnavailable);
            const list = skillList(response.body);
            if (list === undefined)
                return errorResult("Eragon returned an invalid skill list.");
            const words = (query ?? "").toLowerCase().split(/[-_\s]+/).filter(Boolean);
            return textResult(JSON.stringify({
                ...list,
                skills: list.skills.filter(({ name, description }) => {
                    const text = `${name} ${description}`.toLowerCase();
                    return words.every((word) => text.includes(word));
                }),
            }, null, 2));
        }
        if (name === "skill_get") {
            const { idOrName, path } = args;
            if (!validSkillId(idOrName))
                return errorResult("skill_get requires an ID or name.");
            if (path !== undefined && !isFilePath(path))
                return errorResult("skill_get path must be a bundle-relative file path.");
            const skill = `${SKILLS_PATH}/${encodeURIComponent(idOrName.trim())}`;
            const response = path === undefined
                ? await get(skill)
                : await get(`${skill}/files/${path.split("/").map(encodeURIComponent).join("/")}`, "text");
            if (response.status !== 200)
                return gatewayError(response, "read", onUnavailable);
            if (path !== undefined)
                return textResult(String(response.body));
            if (!isSkillDetail(response.body))
                return errorResult("Eragon returned invalid skill metadata.");
            return textResult(JSON.stringify(response.body, null, 2));
        }
        if (name !== "skill_propose" && name !== "skill_revise")
            return errorResult(`Unknown Eragon Skills tool: ${name}`);
        const { body, files, reason } = args;
        if (!nonEmpty(body) || !nonEmpty(reason))
            return errorResult(`${name} requires a body and reason.`);
        if (Buffer.byteLength(body) > BODY_MAX_BYTES)
            return errorResult("The skill body must be at most 64 KiB of UTF-8 text.");
        if (reason.length > REASON_MAX)
            return errorResult(`The proposal reason must be at most ${REASON_MAX} characters.`);
        const isNew = name === "skill_propose";
        let proposal;
        if (isNew) {
            const { name: skillName, description } = args;
            if (typeof skillName !== "string" || skillName.length > NAME_MAX || !NAME_REGEX.test(skillName)) {
                return errorResult(`The skill name must be kebab-case with at most ${NAME_MAX} characters, such as release-notes.`);
            }
            if (!nonEmpty(description) || description.trim().length > DESCRIPTION_MAX) {
                return errorResult(`The skill description must contain 1 to ${DESCRIPTION_MAX} characters.`);
            }
            proposal = { name: skillName, description, body, reason };
            if (files !== undefined) {
                if (!Array.isArray(files) || files.length > FILES_MAX || !files.every(isProposalFile)) {
                    return errorResult(`Provide at most ${FILES_MAX} files with bundle-relative paths and text content.`);
                }
                const paths = new Set(files.map(({ path }) => path));
                if (paths.has("SKILL.md") || paths.size !== files.length) {
                    return errorResult("Use unique companion file paths and send SKILL.md as body.");
                }
                if (files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content), 0) > FILES_MAX_BYTES) {
                    return errorResult("The proposed files must total at most 1 MiB of UTF-8 text.");
                }
                proposal.files = files.map(({ path, content }) => ({ path, content }));
            }
        }
        else {
            if (files !== undefined)
                return errorResult("skill_revise accepts only SKILL.md changes. Remove files and submit the updated body.");
            if (args.name !== undefined || args.description !== undefined) {
                return errorResult("skill_revise accepts only SKILL.md changes. Remove name and description and submit the updated body.");
            }
            const { skillId, baseVersion } = args;
            if (!validSkillId(skillId) || typeof baseVersion !== "number" || !Number.isSafeInteger(baseVersion) || baseVersion < 1) {
                return errorResult("skill_revise requires a skillId and an integer baseVersion from skill_get.");
            }
            // Eragon fills in the published metadata. A separate detail GET records a skill use.
            proposal = { body, reason, baseSkillId: skillId.trim(), baseVersion };
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
            retryOnNetworkError: isNew,
        });
        if (response.status !== 201)
            return gatewayError(response, "write", onUnavailable);
        const receipt = response.body;
        const kind = isNew ? "skill" : "revision";
        if (!isRecord(receipt) || receipt.status !== "proposed" || receipt.kind !== kind ||
            !nonEmpty(receipt.skillId) || receipt.proposalId !== receipt.skillId || !nonEmpty(receipt.reviewUrl) ||
            (kind === "revision" && (receipt.skillId !== proposal.baseSkillId || receipt.baseVersion !== proposal.baseVersion))) {
            return errorResult("Eragon did not return a valid proposal receipt. Check Skills → Installed before submitting again.");
        }
        const reviewUrl = receipt.reviewUrl === "/skills/installed"
            ? new URL(receipt.reviewUrl, config.gatewayUrl).href : receipt.reviewUrl;
        return textResult(JSON.stringify({ ...receipt, reviewUrl }, null, 2));
    }
    catch {
        return errorResult(submitting
            ? "Could not confirm the Eragon skill proposal. Check Skills → Installed before submitting again."
            : "Could not read Eragon Skills. Try again.");
    }
}
//# sourceMappingURL=skill-tools.js.map