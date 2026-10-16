import assert from 'node:assert/strict';
import test from 'node:test';
import { mpegCRC32 } from '../src/mpeg-crc.mjs';
function reference(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes){crc^=byte<<24;for(let bit=0;bit<8;bit++)crc=(crc&0x80000000)?((crc<<1)^0x04c11db7)>>>0:(crc<<1)>>>0;}
  return crc>>>0;
}
test('table CRC matches MPEG-2 check value and the previous bitwise algorithm', () => {
  assert.equal(mpegCRC32(Buffer.from('123456789')),0x0376e6e7);
  let seed=123456;
  for(const length of [0,1,2,16,188,1024,4092])for(let round=0;round<8;round++){
    const bytes=Buffer.alloc(length);
    for(let i=0;i<length;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;bytes[i]=seed>>>24;}
    assert.equal(mpegCRC32(bytes),reference(bytes));
    const section=Buffer.concat([bytes,Buffer.alloc(4)]);section.writeUInt32BE(mpegCRC32(bytes),length);
    assert.equal(mpegCRC32(section),0);
  }
});
