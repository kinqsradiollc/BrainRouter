# Database Schema

This document describes the data models and relationships for the project.

## 🗄️ Database Type
- Primary: [e.g., PostgreSQL, MongoDB, Appwrite]

---

## 🗺️ Entity Relationship Diagram
(Link to diagram or describe relationships here)

---

## 📑 Collections / Tables

### `users`
| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | UUID | Primary Key |
| `email` | String | Unique email |
| `name` | String | Display name |
| `createdAt` | DateTime | Creation timestamp |

### `resources`
| Field | Type | Description |
| :--- | :--- | :--- |
| `id` | UUID | Primary Key |
| `ownerId` | UUID | FK to users.id |
| `status` | Enum | [DRAFT, PUBLISHED] |

---

## 🛡️ Security Rules
- [Describe RLS or ACL policies here]
