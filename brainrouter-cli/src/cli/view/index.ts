/**
 * Read-only display surfaces — pure renderers that turn a state snapshot into
 * a string/stdout write: the startup banner, the federation incoming-message
 * banner, the footer status-line segments, and the `/where` panel.
 */
export * from './banner.js';
export * from './incomingBanner.js';
export * from './statusline.js';
export * from './whereView.js';
