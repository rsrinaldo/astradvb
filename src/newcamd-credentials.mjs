// Configuration parsing only. No provider sockets, ECM processing or keys.
export function parseNewcamdLine(value) {
  const parts = String(value || '').trim().split(/\s+/);
  if (['N:', 'NEWCAMD:', 'C:'].includes(parts[0]?.toUpperCase())) parts.shift();
  if (parts.length !== 5) throw new Error('Newcamd credentials must be: [N:] host port username password des-key');
  const [host, portValue, username, password, desKey] = parts, port = Number(portValue);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Newcamd host or port');
  if (!username || !password) throw new Error('Newcamd username and password are required');
  if (!/^[a-fA-F0-9]{28}$/.test(desKey)) throw new Error('Newcamd DES key must contain 28 hexadecimal characters');
  return { host, port, username, password, desKey: desKey.toLowerCase() };
}
