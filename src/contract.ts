import type { CommandRunner } from "./command.js";
import { buildContractBlock } from "./contract-text.js";
import { readProjectContract } from "./workspaces.js";

export type ContractSettings = { file: string; maxChars: number; rules: string[] };

/**
 * The prompt block for a task (ADR 0011): the global drift rules plus the contract file as committed at the task's base commit. A repository without that file gets no block at all,
 * because the global rules alone say nothing about what that project is for, and a read failure never stops a task, only leaves it without the block.
 */
export async function projectContractBlock(input: { gitRoot: string; baseSha: string; settings: ContractSettings }, runner?: CommandRunner): Promise<string | undefined> {
  const { settings } = input;
  const contract = await readProjectContract(input.gitRoot, input.baseSha, settings.file, settings.maxChars, runner).catch(() => undefined);
  return contract ? buildContractBlock({ rules: settings.rules, contract, file: settings.file, maxChars: settings.maxChars }) : undefined;
}
