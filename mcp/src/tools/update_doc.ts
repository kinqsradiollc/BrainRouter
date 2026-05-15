import { z } from 'zod';
import type { Registry } from '../registry.js';
import { updateDocSection } from '../writer.js';

export const updateDocSchema = z.object({
  name: z.string(),
  section: z.string(),
  content: z.string(),
  createIfMissing: z.boolean().optional().default(true),
});

export async function updateDoc(registry: Registry, args: z.infer<typeof updateDocSchema>) {
  const manifest = registry.getDoc(args.name);
  if (!manifest) {
    throw new Error(`Document "${args.name}" not found.`);
  }

  const localRoot = registry.getLocalRoot();
  if (!localRoot) {
    throw new Error('No local root detected. Documentation updates are only allowed in project repositories.');
  }

  const updatedPath = updateDocSection(
    manifest.filePath,
    args.section,
    args.content,
    localRoot,
    args.createIfMissing
  );

  return {
    content: [
      {
        type: 'text',
        text: `Successfully updated section "${args.section}" in ${manifest.name}.`,
      },
    ],
    metadata: {
      path: updatedPath,
    },
  };
}
