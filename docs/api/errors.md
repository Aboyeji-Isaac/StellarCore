# API Error Responses

StellarCore public APIs use a standardized error envelope to provide consistent, machine-readable error responses across all endpoints.

## Error Envelope Structure

All error responses follow this structure:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": { ... }
  }
}
```

### Fields

| Field      | Type               | Description                                                                 |
|------------|--------------------|-----------------------------------------------------------------------------|
| `code`     | string (enum)      | Machine-readable error code (see below)                                    |
| `message`  | string             | Human-readable error description                                           |
| `details`  | object (optional)  | Additional context (sanitized, never contains sensitive information)       |

## Error Codes

| Code                  | HTTP Status | Description                                                                 |
|-----------------------|-------------|-----------------------------------------------------------------------------|
| `VALIDATION_ERROR`    | 400         | Invalid input parameters or request body                                   |
| `NOT_FOUND`           | 404         | Requested resource does not exist                                          |
| `RATE_LIMITED`        | 429         | Too many requests in a given time window                                    |
| `INTERNAL_ERROR`      | 500         | Unexpected internal server error (generic message, details logged)        |
| `SERVICE_UNAVAILABLE` | 503         | Service temporarily unavailable (maintenance, dependencies, etc.)         |

## Examples

### Validation Error (400)

**Request:**
```
GET /api/accounts?address=invalid
```

**Response:**
```json
HTTP/1.1 400 Bad Request
Content-Type: application/json

{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid address format",
    "details": {
      "field": "address",
      "reason": "must be a valid Stellar address"
    }
  }
}
```

### Not Found (404)

**Request:**
```
GET /api/accounts/GCLWGQPMKXQSPF776IU33AH4PZNOZE
```

**Response:**
```json
HTTP/1.1 404 Not Found
Content-Type: application/json

{
  "error": {
    "code": "NOT_FOUND",
    "message": "Account not found"
  }
}
```

### Rate Limited (429)

**Request:**
```
GET /api/transactions (too many requests)
```

**Response:**
```json
HTTP/1.1 429 Too Many Requests
Content-Type: application/json
Retry-After: 60

{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests",
    "details": {
      "retryAfter": 60
    }
  }
}
```

### Internal Error (500)

**Request:**
```
GET /api/operations
```

**Response:**
```json
HTTP/1.1 500 Internal Server Error
Content-Type: application/json

{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Internal server error"
  }
}
```

## Implementation Notes

1. **Never expose sensitive information** in error responses:
   - Stack traces
   - Database errors
   - Raw upstream responses
   - Secrets, JWTs, or private endpoint details

2. **All sensitive errors** should be:
   - Logged internally with full context
   - Returned to clients as generic `INTERNAL_ERROR` or `SERVICE_UNAVAILABLE`

3. **Validation errors** should include:
   - The specific field(s) that failed validation
   - The reason for failure (without exposing implementation details)

4. **Rate limit errors** should include:
   - Standard `Retry-After` header
   - Optional `retryAfter` in response body

5. **Error codes are stable** and will not change between minor versions.
