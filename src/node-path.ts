import { realpathSync } from "node:fs";

/** Real path of this Node binary, resolved once at startup. Version managers (nvm) re-create the symlinked install path while a run is in flight, which would make spawn(process.execPath) fail with ENOENT. */
export const NODE_EXECUTABLE = (() => { try { return realpathSync(process.execPath); } catch { return process.execPath; } })();
