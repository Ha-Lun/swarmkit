"""Request handling for the user service: handle(...) -> (status, body). No sockets, so it is testable directly."""
import sqlite3

import store
import validate


def handle(method, path, query, body, db):
    if method == "GET" and path == "/health":
        return 200, {"status": "ok"}
    if method == "GET" and path == "/users":
        return 200, {"users": store.list_users(db)}
    if method == "GET" and path.startswith("/users/"):
        user = store.get_user(db, path.split("/")[2]) if path.split("/")[2].isdigit() else None
        return (200, user) if user else (404, {"error": "not found"})
    if method == "POST" and path == "/users":
        errors = validate.validate_user(body or {})
        if errors:
            return 400, {"errors": errors}
        try:
            return 201, store.create_user(db, body["name"].strip(), body["email"])
        except sqlite3.IntegrityError:
            return 409, {"error": "email already registered"}
    return 404, {"error": "not found"}
