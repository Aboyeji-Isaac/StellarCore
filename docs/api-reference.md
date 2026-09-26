# Public API reference

The read-only JSON routes under `/api/anchors`, `/api/corridors`, `/api/rates`,
and `/api/reputation` are callable from browser applications on any origin.
Successful and error responses from these public `GET` routes include:

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET
Access-Control-Allow-Headers: Content-Type
```

The wildcard origin is intentional: these endpoints expose only bounded,
public read models and do not accept cookies or credentials. Clients must not
send authentication credentials to them. The authenticated internal refresh
route at `/api/internal/cron/refresh` is not public CORS-enabled and remains
protected by its server-only bearer secret.

See the [README API reference](../README.md#api-reference) for route payloads,
status codes, and read-model semantics.
