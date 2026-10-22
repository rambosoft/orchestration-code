# ADR 0002: Use a supported external Paperclip adapter

Status: Accepted

Implement a separately packaged external adapter against Paperclip's server adapter contract. Keep Temporal and provider logic outside Paperclip core. If a running Paperclip release rejects the documented local adapter interface, record that as blocked instead of patching Paperclip internals.
