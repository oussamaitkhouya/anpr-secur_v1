"""City scoping, enforced in the queries themselves.

An analyst's queries get `WHERE <city column> IN (<their cities>)` added before they reach the
database, so rows from other cities are never loaded, counted or returned: the API cannot leak
them by mistake, and nothing relies on the dashboard hiding them. Admins and auditors
(Actor.city_ids is None) are not restricted. An analyst with no cities sees nothing.

Single-object lookups that fall outside the scope return 404, not 403, so an analyst cannot
probe which ids exist in other cities.
"""

from sqlalchemy import Select, false

from anpr.db.models import Alert, Camera, City, DetectionEvent
from anpr.security.rbac import Actor


def by_city(stmt: Select, city_column, actor: Actor) -> Select:
    if actor.city_ids is None:
        return stmt
    if not actor.city_ids:
        return stmt.where(false())
    return stmt.where(city_column.in_(actor.city_ids))


def cities(stmt: Select, actor: Actor) -> Select:
    return by_city(stmt, City.id, actor)


def cameras(stmt: Select, actor: Actor) -> Select:
    """stmt must select from cameras."""
    return by_city(stmt, Camera.city_id, actor)


def detections(stmt: Select, actor: Actor) -> Select:
    """stmt selects from detection_events; joins cameras to reach the city."""
    return by_city(stmt.join(Camera, Camera.id == DetectionEvent.camera_id), Camera.city_id, actor)


def alerts(stmt: Select, actor: Actor) -> Select:
    """stmt selects from alerts; joins detection and camera to reach the city."""
    stmt = stmt.join(DetectionEvent, DetectionEvent.id == Alert.detection_id).join(Camera, Camera.id == DetectionEvent.camera_id)
    return by_city(stmt, Camera.city_id, actor)
