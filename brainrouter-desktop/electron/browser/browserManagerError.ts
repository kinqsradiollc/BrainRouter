import type { BrowserErrorCode } from './protocol.js';

export class BrowserManagerError extends Error {
  constructor(
    public readonly code: BrowserErrorCode,
    message: string,
  ) {
    super(message);
  }
}
