import { AGENT_TOOL_NAME, GENERAL_PURPOSE_AGENT_TYPE } from '../AgentTool/constants.js'
import { ORCHESTRATION_CONTRACT_TOOL_NAME } from './constants.js'

export const DESCRIPTION = 'Publish or show the contract all Orchestrator workers follow'

export function getOrchestrationContractPrompt(): string {
  return `
# ${ORCHESTRATION_CONTRACT_TOOL_NAME}

Publish the contract before you launch implementation workers. Workers cannot see each other: the contract is how they agree on file boundaries, names and shapes. Keep it as small as the job: one packet for a one-file change, several for work that splits.

A contract has:
- \`goal\`: what the run delivers.
- \`checks\` (required): at least one required check — a command whose \`required\` is not false. These prove the whole integrated result works after every packet; they are **not** a packet's \`acceptance\`. A contract with no check or \`checks: []\` is refused. \`orchestrator.checkCommands\` from settings runs in addition, never instead.
- \`packets\`: one per worker. Each has a kebab-case \`name\` (launch its worker with that name), an \`objective\`, the files it \`owns\`, and \`acceptance\` criteria (what proves that packet alone is done). \`owns\` are paths or globs relative to the project root (\`src/api/**\`, \`docs/CHANGELOG.md\`); an absolute path inside the project is accepted and converted. Packets that can run at the same time must not own the same files.

The **project root** is the git root of the working directory, or the working directory itself when it is not a git repository. Sibling repositories are not included: if the work spans more than one, run the session from a directory that contains all of them, or publish a separate contract for each project. \`*\`, \`?\` and \`{a,b}\` are wildcards; parentheses and brackets are literal, so \`app/(main)/layout.tsx\` and \`app/[slug]/page.tsx\` name those exact directories.
- \`sharedInterfaces\`: every type, function, endpoint or format more than one packet uses, with its exact \`definition\`, the \`owner\` packet that writes it and the \`path\` it lives in. Consumers code against the definition, so they run at the same time as the owner.
Each check runs from the project root, in a shell, and must exit 0 only when the result is right. Use commands that already exist in this project (read \`package.json\`, a Makefile, or the README if unsure), such as the type-check or test command, or a short \`grep\`/\`node -e\` assertion. Never invent a script path such as \`checks/foo.check.ts\`. Up to 2000 characters; longer logic belongs in a script file.

**Run packets at the same time.** Add \`dependsOn\` only when a packet needs another packet's finished files, not just an interface already defined above. Every dependency makes a packet wait for the whole other packet, so the fewest dependencies give the most parallelism. Split by file area, not by step.

Example:

\`\`\`json
{"action": "publish", "contract": {
  "goal": "Users have a display name that the UI shows.",
  "checks": [
    {"name": "typecheck", "command": "bun run typecheck"},
    {"name": "tests", "command": "bun test"}
  ],
  "packets": [
    {"name": "types", "objective": "Add displayName to User", "owns": ["src/types/**"], "acceptance": ["User has displayName: string"]},
    {"name": "api", "objective": "fetchUser returns displayName", "owns": ["src/api/**"], "acceptance": ["fetchUser('u1').displayName is set"]},
    {"name": "ui", "objective": "renderUser shows displayName", "owns": ["src/ui/**"], "acceptance": ["renderUser renders the display name"]}
  ],
  "sharedInterfaces": [
    {"name": "User", "owner": "types", "path": "src/types/user.ts", "definition": "export interface User { id: string; displayName: string }", "consumers": ["api", "ui"]}
  ]
}}
\`\`\`

The result lists the order. Launch every packet of a line together, in one message: ${AGENT_TOOL_NAME} with \`subagent_type: "${GENERAL_PURPOSE_AGENT_TYPE}"\` and \`name\` set to the packet name (workers run in the background). Start a packet from a later line when the packets it depends on have finished.

To change ownership, an interface or the checks, publish the whole contract again with a \`reason\`. A packet whose worker has started cannot be removed.

\`{"action": "show"}\` prints the current contract, for example after the conversation was compacted.

Only the Orchestrator's main agent can use this tool.
`.trim()
}
