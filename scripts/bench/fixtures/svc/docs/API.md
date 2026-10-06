# User service API

| Method | Path | Description |
|---|---|---|
| GET | /health | Liveness check. Returns `{"status": "ok"}`. |
| GET | /users | All users, by id. |
| GET | /users/<id> | One user, or 404. |
| POST | /users | Create a user from `{name, email}`. 201, 400 on invalid input, 409 if the email is taken. |

A user is `{id, name, email}`.
