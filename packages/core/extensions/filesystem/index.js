/** Required built-in capability. The privileged port exists only on the core-owned host. */
export function activate(host) {
  if (typeof host.registerCoreCapability !== 'function') throw new Error('filesystem requires the internal core capability host');
  host.registerCoreCapability('filesystem');
}
