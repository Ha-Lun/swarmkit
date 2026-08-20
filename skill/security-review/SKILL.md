---
name: security-review
description: Use when scanning code for security vulnerabilities — secrets leakage, hardcoded credentials, injection flaws, auth bypass, insecure configurations, and dangerous patterns. Loaded by the security-auditor agent.
---

# Security Review

Systematic methodology for identifying security vulnerabilities in production code.

## Check categories

### 1. Secrets & credentials
- API keys, tokens, passwords, connection strings in source files.
- `.env` files or `.env.example` containing real secrets.
- Hardcoded secrets in tests, documentation, or configuration examples.
- Certificates or private keys committed to the repository.
- AWS/GCP/Azure access keys, service account JSON files.

Search patterns:
```
rg -i "api[_-]?key|secret|password|token|credential|auth_token|access_key" --type-add 'code:*.{js,ts,py,go,rs,cs,java,rb,php}'
rg "-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----"
rg "(AKIA|SK)([A-Z0-9]{16,})"  # AWS key patterns
```

### 2. Injection
- SQL: string concatenation in queries (`SELECT * FROM users WHERE id = '${id}'`).
- Command: `os.system()`, `subprocess.Popen(shell=True)`, `child_process.exec()`, `exec()`.
- Template: unescaped user input in templates, `dangerouslySetInnerHTML`, `@Html.Raw`.
- NoSQL: `$where` clauses, `$regex` with user input.
- Path: user input in file operations without normalization.

### 3. Authentication & authorization
- Missing auth middleware on protected routes.
- Hardcoded credentials or default passwords.
- Weak password policies or lack of rate limiting on login endpoints.
- JWT without signature verification, weak signing key, or missing expiration.
- Session tokens in URL parameters or logs.
- Missing CSRF tokens on state-changing endpoints.

### 4. Configuration
- Debug mode or verbose error output enabled in production.
- CORS configured as `Access-Control-Allow-Origin: *` for authenticated endpoints.
- Default credentials unchanged.
- Admin or internal endpoints exposed without authentication.
- `S3`/`GCS` buckets with public read/write permissions.
- TLS/SSL verification disabled in HTTP clients.

### 5. Logging & information disclosure
- Logging passwords, tokens, PII, or `request.body` in production paths.
- Stack traces or internal error details exposed in API responses.
- Verbose error messages that reveal database schema, file paths, or internal state.
- Full HTTP headers logged in production.

### 6. File operations
- Path traversal: user input in file paths without normalization (`path.join`, `path.resolve`).
- Unsafe deserialization: `JSON.parse` on untrusted input, `pickle.loads`, `YAML.load`.
- Symlink attacks: writing files to world-writable directories.
- Temporary files in predictable locations.

### 7. Dependencies
- Known vulnerable versions of direct and transitive dependencies.
- Deprecated packages with unmaintained security patches.

## Severity classification

| Severity | Criteria |
|---|---|
| Critical | Remote code execution, auth bypass, credential leakage. Immediate production risk. |
| High | Injection, sensitive data exposure, privilege escalation. Should fix before next deploy. |
| Medium | Missing security headers, overly permissive CORS, verbose error messages. Fix within sprint. |
| Low | Information leakage in comments, missing rate limiting, cookie not marked HttpOnly. Fix when convenient. |

## Reporting

Every finding must include: severity, file path with line number, description of the vulnerability, and a concrete remediation suggestion.
