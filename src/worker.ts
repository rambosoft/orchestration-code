import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./activities.js";
import { fileURLToPath } from "node:url";
import { workerEnvironmentErrors } from "./env-validation.js";

const problems = workerEnvironmentErrors(process.env);
if (problems.length) { console.error(["worker configuration is invalid:", ...problems.map(problem => `- ${problem}`)].join("\n")); process.exit(1); }
const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
const concurrency = Number(process.env.ORCHESTRATOR_MAX_ACTIVITY_CONCURRENCY ?? 2);
const connection = await NativeConnection.connect({ address });
const worker = await Worker.create({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default", taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? "orchestration", workflowsPath: fileURLToPath(new URL("./workflows.js", import.meta.url)), activities, maxConcurrentActivityTaskExecutions: concurrency });
await worker.run();
