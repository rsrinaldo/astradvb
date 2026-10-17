#!/usr/bin/env python3
"""Disposable generated-media CPU diagnostic; no network/config/provider reads.

Run the WHOLE program in a PrivateNetwork=yes, CPUQuota=100% disposable unit.
Only public synthetic CWs are used. CPU numbers describe native child rusage,
not real-time playback or the live system. No application files are modified.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import tempfile
import time

WORD = '1234569c789abcce1234569c789abcce'
ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}


def command(arguments, **kwargs):
    result = subprocess.run(arguments, env=ENV, timeout=60, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, **kwargs)
    if result.returncode:
        raise RuntimeError('isolated fixture command failed: ' + Path(arguments[0]).name)
    return result.stdout


def packets(data):
    if len(data) % 188:
        raise RuntimeError('unaligned generated fixture')
    for at in range(0, len(data), 188):
        packet = data[at:at + 188]
        if packet[0] != 0x47:
            raise RuntimeError('bad generated sync')
        yield packet


def pid(packet):
    return ((packet[1] & 31) << 8) | packet[2]


def inspect_output(path):
    digest, count, scrambled = hashlib.sha256(), 0, 0
    with path.open('rb') as handle:
        while True:
            chunk = handle.read(188 * 4096)
            if not chunk:
                break
            for packet in packets(chunk):
                if pid(packet) in (256, 257):
                    digest.update(packet)
                    count += 1
                    scrambled += bool(packet[3] & 0xc0)
    return digest.hexdigest(), count, scrambled


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--release', required=True)
    parser.add_argument('--old', required=True)
    parser.add_argument('--new', required=True)
    parser.add_argument('--repeat', type=int, default=16)
    args = parser.parse_args()
    if not 1 <= args.repeat <= 64:
        raise RuntimeError('repeat must be bounded 1..64')
    release, old, new = map(lambda value: Path(value).resolve(strict=True),
                            (args.release, args.old, args.new))
    source = release / 'test/native-csa-encrypt.c'
    if not source.is_file() or not all(path.is_file() and os.access(path, os.X_OK) for path in (old, new)):
        raise RuntimeError('explicit fixture source and executables required')
    with tempfile.TemporaryDirectory(prefix='astra-const-cw-benchmark-') as temporary:
        directory = Path(temporary)
        encryptor, raw = directory / 'encryptor', directory / 'raw.ts'
        command(['cc', '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', str(source), '-ldvbcsa', '-o', str(encryptor)])
        command(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
                 '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25',
                 '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
                 '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '1',
                 '-g', '25', '-bf', '0', '-b:v', '4M', '-minrate', '4M', '-maxrate', '4M', '-bufsize', '8M',
                 '-c:a', 'mp2', '-b:a', '192k', '-streamid', '0:256', '-streamid', '1:257',
                 '-mpegts_service_id', '1', '-mpegts_pmt_start_pid', '4096',
                 '-muxrate', '6000000', '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', str(raw)])
        initial, av = {}, []
        for packet in packets(raw.read_bytes()):
            number = pid(packet)
            if number in (0, 17, 4096) and number not in initial:
                initial[number] = packet
            if number in (256, 257):
                av.append(packet)
        if set(initial) != {0, 17, 4096} or not av or not all(any(pid(p) == number for p in av) for number in (256, 257)):
            raise RuntimeError('generated A/V and PSI required')
        reference = b''.join(av)
        expected = hashlib.sha256()
        for _ in range(args.repeat):
            expected.update(reference)
        expected_hash, expected_packets = expected.hexdigest(), len(av) * args.repeat
        null = bytes([0x47, 0x1f, 0xff, 0x10]) + bytes([0xff]) * 184
        for pattern in ('both-encrypted-compact', 'video-encrypted-clear-audio-control'):
            unit = bytearray(b''.join(initial.values()))
            for index, packet in enumerate(av):
                unit.extend(packet)
                if pattern != 'both-encrypted-compact' and index % 7 == 6:
                    unit.extend(null)
            # Exact decoder input-frame tail; these controls are not A/V.
            while len(unit) // 188 % 7:
                unit.extend(null)
            encrypted = command([str(encryptor)] + ([] if pattern == 'both-encrypted-compact' else ['--video-only']), input=bytes(unit))
            if len(encrypted) != len(unit):
                raise RuntimeError('encryption changed transport size')
            input_path = directory / 'input.ts'
            with input_path.open('wb') as handle:
                for _ in range(args.repeat):
                    handle.write(encrypted)
            encrypted_av = sum(pid(p) in (256, 257) and bool(p[3] & 0xc0) for p in packets(encrypted)) * args.repeat
            for label, binary in (('old', old), ('new', new)):
                output = directory / 'output.ts'
                before = resource.getrusage(resource.RUSAGE_CHILDREN)
                began = time.monotonic()
                with input_path.open('rb') as incoming, output.open('wb') as outgoing:
                    child = subprocess.run([str(binary), '--const-cw', WORD, '--input-service', '1',
                                            '--input-buffer', '0', '--no-output-filter', '--no-output-on-error',
                                            '--ecm-no-log', '--ecm-report-time', '0'], stdin=incoming, stdout=outgoing,
                                           stderr=subprocess.DEVNULL, env=ENV, timeout=45)
                wall = time.monotonic() - began
                after = resource.getrusage(resource.RUSAGE_CHILDREN)
                cpu = after.ru_utime + after.ru_stime - before.ru_utime - before.ru_stime
                actual_hash, actual_packets, scrambled = inspect_output(output)
                exact = child.returncode == 0 and (actual_hash, actual_packets, scrambled) == (expected_hash, expected_packets, 0)
                size = input_path.stat().st_size
                print(json.dumps({'pattern': pattern, 'binary': label, 'measurement': 'isolated-native-child-rusage-not-live-playback',
                                  'inputBytes': size, 'encryptedAVPackets': encrypted_av, 'expectedAVPackets': expected_packets,
                                  'actualAVPackets': actual_packets, 'scrambledAVPackets': scrambled, 'exactAV': exact,
                                  'cpuSeconds': round(cpu, 6), 'wallSeconds': round(wall, 6),
                                  'cpuMsPerInputMiB': round(cpu * 1000 / (size / 1048576), 6)}), flush=True)
                output.unlink()
                if not exact:
                    raise RuntimeError('strict generated A/V oracle failed; do not use CPU result as a healthy comparison')


if __name__ == '__main__':
    main()
