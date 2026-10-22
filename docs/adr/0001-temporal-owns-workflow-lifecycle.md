# ADR 0001: Temporal owns workflow lifecycle

Status: Accepted

Paperclip remains the management interface and starts one adapter execution per task. The adapter delegates the entire multistage run to Temporal. This keeps scheduling, retries, waits, cancellation and recovery under one workflow engine and prevents Paperclip and Temporal from independently executing the same stages.
