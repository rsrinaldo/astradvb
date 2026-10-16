const table = new Uint32Array(256);
for (let value = 0; value < 256; value++) {
  let crc = value << 24;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 0x80000000) ? ((crc << 1) ^ 0x04c11db7) : (crc << 1);
  table[value] = crc >>> 0;
}

// CRC-32/MPEG-2: identical polynomial/init/no-final-XOR semantics, one table
// lookup per byte instead of eight bit iterations for every repeated section.
export function mpegCRC32(bytes) {
  let crc = 0xffffffff;
  for (let offset = 0; offset < bytes.length; offset++) crc = ((crc << 8) ^ table[((crc >>> 24) ^ bytes[offset]) & 255]) >>> 0;
  return crc;
}
