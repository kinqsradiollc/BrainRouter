import { z } from 'zod';
import type { Registry } from '../registry.js';
import { loadDocSection } from '../loader.js';

export const getTemplateDocSchema = z.object({
  name: z.string(),
  section: z.string().optional(),
});

export async function getTemplateDoc(registry: Registry, args: z.infer<typeof getTemplateDocSchema>) {
  const manifest = registry.getDoc(args.name);
  if (!manifest) {
    throw new Error(`Document "${args.name}" not found.`);
  }

  const fragment = loadDocSection(manifest.filePath, args.section);

  return {
    content: [
      {
        type: 'text',
        text: fragment.content,
      },
    ],
    metadata: {
      tokenEstimate: fragment.tokenEstimate,
    },
  };
}
