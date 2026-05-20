import { z } from 'zod';
import type { Registry } from '../registry.js';
import type { DocCategory } from '../types.js';

export const listTemplateDocsSchema = z.object({
  category: z.enum(['api', 'design', 'schema', 'deployment', 'hooks', 'strategy', 'other']).optional(),
});

export async function listTemplateDocs(registry: Registry, args: z.infer<typeof listTemplateDocsSchema>) {
  const docs = registry.listDocs(args.category as DocCategory);
  
  const sanitized = docs.map(({ filePath, ...rest }) => rest);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(sanitized, null, 2),
      },
    ],
  };
}
