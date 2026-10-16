"""Role permissions, enforced server-side. A copy of dashboard/src/lib/rbac.ts: the dashboard uses
its copy to hide buttons, this one decides. tests/test_permissions.py fails if the two drift apart.
"""

ADMIN = frozenset({
    "overview:view", "alerts:view", "alerts:review", "search:view", "plates:reveal",
    "evidence:view", "evidence:verify", "audit:view", "audit:export", "security:view",
    "models:view", "cameras:view", "camera:live", "settings:view",
    "admin:cameras", "admin:watchlists", "admin:users", "registry:view",
})

PERMISSIONS: dict[str, frozenset[str]] = {
    "super_admin": ADMIN,
    "admin": ADMIN,
    "analyst": frozenset({
        "overview:view", "alerts:view", "alerts:review", "search:view", "plates:reveal",
        "models:view", "cameras:view", "camera:live", "settings:view", "registry:view",
    }),
    "auditor": frozenset({
        "overview:view", "evidence:view", "evidence:verify", "audit:view", "security:view",
        "models:view", "settings:view",
    }),
}


def can(role: str, permission: str) -> bool:
    return permission in PERMISSIONS.get(role, frozenset())
