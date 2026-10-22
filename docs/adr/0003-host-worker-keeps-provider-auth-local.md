# ADR 0003: Run provider worker on the host

Status: Accepted

Keep Paperclip and the Temporal development service in local containers, but run Temporal Activities on Windows. This allows available CLI authentication to remain in the host user profile instead of copying credentials into images or committed configuration.
