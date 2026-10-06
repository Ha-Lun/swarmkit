"""Input validation. Each function returns a list of error strings (empty = valid)."""
import re

EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def validate_user(payload):
    errors = []
    name = payload.get("name")
    if not isinstance(name, str) or not name.strip():
        errors.append("name is required")
    email = payload.get("email")
    if not isinstance(email, str) or not EMAIL.match(email):
        errors.append("email is invalid")
    return errors
