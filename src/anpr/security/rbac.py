"""Role-based access control: the single permission map, and who the caller is.

Every route declares the permission it needs (anpr.api.deps.require). A test walks all routes
and fails if one has no permission check, so a new route cannot be forgotten.

Separation of duties:
    super_admin  every permission below, in every city; the only role that manages admin and
             super admin accounts. Keep it to one or two people: it bypasses the split below
    admin    configures the system (cities, cameras, users, watchlists), reads the audit log and
             can clear the detection history (audited, with a written justification)
    analyst  reviews alerts and reveals plates, only in their assigned cities
    auditor  read-only oversight: audit log and alerts, never plate reveal. No camera registry:
             camera locations and network details are need-to-know (docs/camera_registry.md)
The detection service is not a user: it authenticates with its own token and can only ingest.
"""

import uuid
from dataclasses import dataclass

# "self" = endpoints about the caller's own account (GET /auth/me).
PERMISSIONS: dict[str, frozenset[str]] = {
    "admin": frozenset({
        "self", "overview.read",
        "cities.read", "cities.write",
        "cameras.read", "cameras.write", "cameras.credentials.write", "cameras.live",
        "users.read", "users.write",
        "watchlists.read", "watchlists.write",
        "alerts.read",
        "plates.search",
        "audit.read", "audit.export", "audit.verify",
        "evidence.read", "security.read", "models.read", "system.read",
        "detections.purge",
    }),
    "analyst": frozenset({
        "self", "overview.read",
        "cities.read",
        "cameras.read", "cameras.live",
        "watchlists.read",
        "alerts.read", "alerts.review",
        "plates.search", "plates.reveal",
        "models.read",
    }),
    "auditor": frozenset({
        "self", "overview.read",
        "cities.read",
        "watchlists.read",
        "alerts.read",
        "audit.read", "audit.export", "audit.verify",
        "evidence.read", "security.read", "models.read",
    }),
}

ALL_PERMISSIONS = frozenset().union(*PERMISSIONS.values())
PERMISSIONS["super_admin"] = ALL_PERMISSIONS

# Roles that see every city. Everyone else sees only the cities in user_cities.
UNSCOPED_ROLES = frozenset({"super_admin", "admin", "auditor"})

# Accounts with these roles are created, changed and reset only by a super admin.
PRIVILEGED_ROLES = frozenset({"super_admin", "admin"})


def allowed(role: str, permission: str) -> bool:
    return permission in PERMISSIONS.get(role, frozenset())


@dataclass(frozen=True)
class Actor:
    """Who is making the request. Built from the database on every request (not from the JWT),
    so deactivating a user or changing their role takes effect immediately."""
    id: str
    role: str
    ip: str
    username: str = ""
    city_ids: frozenset[uuid.UUID] | None = None  # None = all cities

    @property
    def is_scoped(self) -> bool:
        return self.city_ids is not None


SERVICE_DETECTIONS = "service:detections"
