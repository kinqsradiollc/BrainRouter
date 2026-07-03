// Goal prompt concern: the pure string builders the agent loop injects each
// turn — the goal-anchor system block, the continuation decision + prompt, and
// the first-turn kickoff/resume prompt. No persistence or side effects here.
export * from './goalFormat.js';
export * from './goalContinuation.js';
export * from './goalKickoff.js';
