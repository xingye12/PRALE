// Stub for the optional `check-disk-space` dependency (node_modules is not
// installed in this evaluation workspace). Only getDiskSpace() uses it; the
// command-execution paths exercised by the demo never call it.
export default async function checkDiskSpace() {
  return { size: 0, free: 0 }
}
