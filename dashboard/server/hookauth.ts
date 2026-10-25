// Loopback check for the agy hook route: local IPv4/IPv6 forms, or the bound HOST itself.
export function isLoopback(addr: string | undefined, host: string): boolean {
  if (!addr) return false;
  const norm = addr.toLowerCase();
  if (norm === '127.0.0.1' || norm === '::1' || norm === '::ffff:127.0.0.1') return true;
  return norm === host.toLowerCase();
}
