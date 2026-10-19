import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export const OSCAM_POLICY_VERSION = 4;
export const OSCAM_SOURCE_REVISION = '39e78a4688b30abaab62b5c9e13672b4e34bfca0';
const verified = new Map();

// Verify the installed binary, not a historical patch marker. No credentials,
// protocol data or keys are read or retained by this integrity check.
export function protectedOscamBuild(binary = process.env.ASTRA_OSCAM || '/usr/local/bin/oscam', manifestPath = process.env.ASTRA_NATIVE_OSCAM_MANIFEST || '/usr/local/share/licenses/oscam/astra-native-oscam.json', { allowExperimental = false, direct = false } = {}) {
  try {
    const b = statSync(binary); const m = statSync(manifestPath);
    if (!b.isFile() || !(b.mode & 0o111) || !m.isFile() || m.size > 16384 || b.size > 32 * 1024 * 1024) return false;
    const identity = [b.ino, b.size, b.mtimeMs, b.ctimeMs, m.ino, m.size, m.mtimeMs, m.ctimeMs].join(':');
    const key = `${binary}\0${manifestPath}\0${allowExperimental === true}\0${direct === true}`;
    if (verified.get(key)?.identity === identity) return verified.get(key).valid;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const releaseAllowed = manifest.experimental === undefined || manifest.experimental === false || (manifest.experimental === true && allowExperimental === true);
    const directAllowed = !direct || (manifest.directTransportPolicyVersion === 2 && /^[a-f0-9]{64}$/.test(manifest.directTransportSha256 || '') && /^[a-f0-9]{64}$/.test(manifest.providerBudgetSha256 || ''));
    const valid = releaseAllowed && directAllowed && manifest.policyVersion === OSCAM_POLICY_VERSION && manifest.semanticPolicyVersion === 4 && /^[a-f0-9]{64}$/.test(manifest.semanticSchedulerSha256 || '') && manifest.sourceRevision === OSCAM_SOURCE_REVISION && /^[a-f0-9]{64}$/.test(manifest.binarySha256 || '') && createHash('sha256').update(readFileSync(binary)).digest('hex') === manifest.binarySha256;
    if (verified.size >= 16) verified.clear();
    verified.set(key, { identity, valid }); return valid;
  } catch { return false; }
}
