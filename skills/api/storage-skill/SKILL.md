# Storage & Media Skill

This skill governs how [PROJECT_NAME] handles file uploads, storage, and retrieval across the platform.

## Rules (MUST FOLLOW)

- **[STOR-001] Service-Based Uploads**
  - All file uploads must use the `StorageService` (`services/storageService.ts`).
  - Never interact with S3 or local disks directly from controllers.

- **[STOR-002] Multi-Part Validation**
  - Use `multer` for multipart form-data parsing.
  - Strictly validate `mimetype` (e.g., `image/jpeg`, `image/png`, `image/webp`).
  - Enforce a 10MB maximum file size.

- **[STOR-003] Atomic Cleanup**
  - When a resource is deleted (e.g., a Spot or Story), all associated files must be deleted from storage via `StorageService.deleteFile(fileId)`.
  - Handle cleanup errors gracefully but log them for manual intervention.

- **[STOR-004] Secure URL Generation**
  - Never store absolute URLs in the database.
  - Always store `file_id` and generate the URL dynamically using `StorageService.getFileUrl(fileId)`.

- **[STOR-005] Optimization**
  - Image uploads for Stories/Spots should be capped at 2000px on the longest edge (handled via frontend or backend resizing).

## Implementation Pattern

```typescript
import { StorageService } from '../../services/storageService';

export const uploadPhoto = async (req: Request, res: Response) => {
  const file = req.file; // From multer
  if (!file) return ErrorResponses.badRequest(res, 'No file provided');

  // [STOR-002] Validate Mimetype
  if (!['image/jpeg', 'image/png'].includes(file.mimetype)) {
    return ErrorResponses.badRequest(res, 'Invalid file type');
  }

  // [STOR-001] Use StorageService
  const uploaded = await StorageService.uploadFile(
    'spot-photos',
    file.buffer,
    file.originalname,
    file.mimetype,
    req.user.id
  );

  return sendSuccess(res, { 
    fileId: uploaded.id,
    url: StorageService.getFileUrl(uploaded.id) 
  });
};
```

## Required Checks

- [ ] `multer` handles file parsing and limits.
- [ ] `mimetype` is validated against an allowlist.
- [ ] Cleanup logic is present for resource deletion.
- [ ] No absolute URLs are stored in the DB.
