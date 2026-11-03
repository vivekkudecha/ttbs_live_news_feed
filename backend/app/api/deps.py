"""Request-scoped dependencies.

Until authentication lands, the acting user comes from the `X-Actor` header (the UI sends the
logged-in username) and falls back to `DEFAULT_ACTOR`. Every audit row records it.
"""

import re

from fastapi import Header

from app.core.config import get_settings
from app.core.context import actor_var

_SAFE = re.compile(r"^[A-Za-z0-9._@-]{1,100}$")


def current_actor(x_actor: str | None = Header(default=None)) -> str:
    actor = x_actor if x_actor and _SAFE.match(x_actor) else get_settings().default_actor
    actor_var.set(actor)
    return actor
