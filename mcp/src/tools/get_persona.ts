import { z } from 'zod';
import { readFileSync } from 'fs';
import type { Registry } from '../registry.js';

export const getPersonaSchema = z.object({
  name: z.string(),
});

export async function getPersona(registry: Registry, args: z.infer<typeof getPersonaSchema>) {
  const manifest = registry.getPersona(args.name);
  if (!manifest) {
    throw new Error(`Persona "${args.name}" not found.`);
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
