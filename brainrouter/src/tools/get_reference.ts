import { z } from 'zod';
import { readFileSync } from 'fs';
import type { Registry } from '../registry.js';

export const getReferenceSchema = z.object({
  name: z.string(),
});

export async function getReference(registry: Registry, args: z.infer<typeof getReferenceSchema>) {
  const manifest = registry.getReference(args.name);
  if (!manifest) {
    throw new Error(`Reference "${args.name}" not found.`);
  }

  const content = readFileSync(manifest.filePath, 'utf-8');
  return {
    content: [
      {
        type: 'text',
        text: content,
      },
    ],
  };
}
