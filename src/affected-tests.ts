const SOURCE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|css|json)$/i;

export const CHANGED_TOKEN = "{changed}";

export function commandHasChangedToken(args: readonly string[]): boolean { return args.includes(CHANGED_TOKEN); }

export function expandChangedArgs(args: readonly string[], changed: readonly string[], limit = 200): { args: string[]; skipped?: "none-changed" | "too-many" } {
  if (!commandHasChangedToken(args)) return { args: [...args] };
  const files = [...new Set(changed.filter(file => SOURCE.test(file) && !file.startsWith("-") && !/[\0\r\n]/.test(file)).map(file => file.replace(/\\/g, "/")))];
  if (!files.length) return { args: [...args], skipped: "none-changed" };
  if (files.length > limit) return { args: [...args], skipped: "too-many" };
  return { args: args.flatMap(arg => arg === CHANGED_TOKEN ? files : [arg]) };
}
