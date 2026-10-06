// Minimal stand-in for the `proper-lockfile` runtime dependency (not installed in this workspace).
// The settings precedence demo only needs the lock calls to be no-ops.
export default {
	lockSync: () => () => {},
	unlockSync: () => {},
	lock: async () => () => {},
	unlock: async () => {},
	check: async () => false,
};
