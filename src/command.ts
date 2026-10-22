import { spawn } from "node:child_process";

export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<string>;
export const runCommand: CommandRunner = (command, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd, shell: false, windowsHide: true }); const out: Buffer[] = []; const err: Buffer[] = [];
  child.stdout.on("data", (b: Buffer) => out.push(b)); child.stderr.on("data", (b: Buffer) => err.push(b));
  child.on("error", reject); child.on("close", code => code === 0 ? resolve(Buffer.concat(out).toString("utf8").trim()) : reject(new Error(Buffer.concat(err).toString("utf8").trim() || `${command} exited ${code}`)));
});
