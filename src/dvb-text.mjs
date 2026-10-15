// ETSI EN 300 468 Annex A: the DVB default alphabet is ISO/IEC 6937.
const upper = [
  ' ','¡','¢','£','€','¥','�','§','¤','‘','“','«','←','↑','→','↓',
  '°','±','²','³','×','µ','¶','·','÷','’','”','»','¼','½','¾','¿',
  '�','�','�','�','�','�','�','�','�','�','�','�','�','�','�','�',
  '—','¹','®','©','™','♪','¬','¦','�','�','�','�','⅛','⅜','⅝','⅞',
  'Ω','Æ','Ð','ª','Ħ','�','Ĳ','Ŀ','Ł','Ø','Œ','º','Þ','Ŧ','Ŋ','ŉ',
  'ĸ','æ','đ','ð','ħ','ı','ĳ','ŀ','ł','ø','œ','ß','þ','ŧ','ŋ','­',
];
const accents = { 0xc1: '\u0300', 0xc2: '\u0301', 0xc3: '\u0302', 0xc4: '\u0303', 0xc5: '\u0304', 0xc6: '\u0306', 0xc7: '\u0307', 0xc8: '\u0308', 0xca: '\u030a', 0xcb: '\u0327', 0xcd: '\u030b', 0xce: '\u0328', 0xcf: '\u030c' };
const spacing = { 0xc1: '`', 0xc2: '´', 0xc3: '^', 0xc4: '~', 0xc5: '¯', 0xc6: '˘', 0xc7: '˙', 0xc8: '¨', 0xca: '˚', 0xcb: '¸', 0xcd: '˝', 0xce: '˛', 0xcf: 'ˇ' };
function iso6937(bytes) {
  let result = '';
  for (let index = 0; index < bytes.length; index++) {
    const byte = bytes[index];
    if (accents[byte] && index + 1 < bytes.length) {
      const base = bytes[++index];
      result += base === 0x20 ? spacing[byte] : `${base < 0xa0 ? String.fromCharCode(base) : upper[base - 0xa0]}${accents[byte]}`;
    } else result += byte < 0xa0 ? String.fromCharCode(byte) : upper[byte - 0xa0];
  }
  return result;
}

export function decodeDVBText(value, { language = '' } = {}) {
  const bytes = Buffer.from(value || []);
  if (!bytes.length) return '';
  let offset = 0; let encoding;
  const selector = bytes[0];
  if (selector >= 0x01 && selector <= 0x0b && selector !== 0x08) { encoding = `iso-8859-${selector + 4}`; offset = 1; }
  else if (selector === 0x10 && bytes.length >= 3 && bytes[1] === 0) { encoding = `iso-8859-${bytes[2]}`; offset = 3; }
  else if ([0x11, 0x12, 0x13, 0x14, 0x15].includes(selector)) {
    encoding = { 0x11: 'utf-16be', 0x12: 'euc-kr', 0x13: 'gb2312', 0x14: 'big5', 0x15: 'utf-8' }[selector]; offset = 1;
  }
  let decoded;
  if (encoding) {
    try { decoded = new TextDecoder(encoding).decode(bytes.subarray(offset)); }
    catch { decoded = iso6937(bytes.subarray(offset)); }
  } else {
    // Some Albanian providers broadcast unmarked Latin-1 rather than the
    // DVB default. Prefer real ISO-6937 accent pairs when present.
    const hasAccentPair = bytes.some((byte, index) => (byte === 0xc8 && [0x65, 0x45].includes(bytes[index + 1])) || (byte === 0xcb && [0x63, 0x43].includes(bytes[index + 1])));
    if (['alb', 'sqi'].includes(language) && !hasAccentPair) decoded = bytes.toString('latin1');
    else decoded = iso6937(bytes);
  }
  return decoded.replace(/\u008a/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '').normalize('NFC').trim();
}
