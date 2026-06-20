export const VERBOSITY_SENTINEL = '<brainrouter-verbosity-steering>';

const INSTRUCTIONS: Record<Exclude<0 | 1 | 2 | 3 | 4, 0>, string> = {
  1: 'Answer directly. Prefer concise prose and omit routine restatement.',
  2: 'Use short sections or bullets when they improve scanning. Keep explanations focused on decisions and evidence.',
  3: 'Maximize information density. State findings, actions, and verification without extended background unless it changes the decision.',
  4: 'Be extremely concise. Return only the result, essential evidence, and concrete next action; omit commentary and repetition.',
};

export function appendVerbositySteering(prompt: string, level: 0 | 1 | 2 | 3 | 4): string {
  if (level === 0 || prompt.includes(VERBOSITY_SENTINEL)) return prompt;
  return `${prompt}\n\n${VERBOSITY_SENTINEL}\n${INSTRUCTIONS[level]}\n</brainrouter-verbosity-steering>`;
}
