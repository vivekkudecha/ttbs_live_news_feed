"""Per-request / per-task context propagated into logs and audit rows."""

from contextvars import ContextVar

request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
actor_var: ContextVar[str | None] = ContextVar("actor", default=None)
job_id_var: ContextVar[int | None] = ContextVar("job_id", default=None)
client_ip_var: ContextVar[str | None] = ContextVar("client_ip", default=None)
user_agent_var: ContextVar[str | None] = ContextVar("user_agent", default=None)
