# API Documentation

This document outlines the API endpoints, authentication, and data structures for the project.

## 🚀 Base URL
- Development: `http://localhost:3001/api`
- Production: `https://api.the project domain.com`

---

## 🔐 Authentication

Describe the authentication mechanism here (e.g., JWT, OAuth2, API Keys).

### Authorization Header
`Authorization: Bearer <token>`

---

## 📡 Endpoints

### [Component/Module Name]

#### `GET /v1/resource`
- **Description**: Fetch a list of resources.
- **Query Params**:
  - `cursor` (optional): Opaque cursor returned by the previous response.
  - `limit` (optional): Page size from `1` to `100`. Defaults to `20`.
- **Response**:
```json
{
  "success": true,
  "data": [],
  "nextCursor": null,
  "limit": 20,
  "hasMore": false
}
```

List endpoints use cursor-based pagination only. Do not use offset or `page` query parameters for live lists.

#### `POST /v1/resource`
- **Description**: Create a new resource.
- **Body**:
```json
{
  "name": "string"
}
```

---

## 🏗️ Error Handling

Standard error response format:
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message"
  }
}
```
