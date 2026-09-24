// Encrypts the face crops so they can live in a public repo as noise.
//
//   node scripts/encrypt-faces.mjs "four random words you will not lose"
//   node scripts/encrypt-faces.mjs --add "same passphrase" trump.jpg
//
// The second form appends. It matters: a plain run mints a NEW random salt, so
// the same passphrase derives a DIFFERENT key, every existing .bin is rewritten
// and the key sitting in the iPad's IndexedDB stops working — somebody has to
// walk over and re-enter the passphrase. --add reuses the stored salt and
// iteration count, so the key on the wall keeps decrypting and the twenty files
// already committed are not touched.
//
// Reads faces-src/*.{jpg,jpeg,png,webp}  (gitignored — never committed)
// Writes faces/<random-id>.bin          (AES-GCM, safe to commit)
//        faces/manifest.json            (salt + iterations + ids + ring colours)
//
// AES-GCM-256, key from PBKDF2-SHA256. Both are native Web Crypto, so the iPad
// decrypts with the same primitives and there is no library to keep current.
// GCM authenticates: a tampered file fails loudly rather than decoding to noise.

import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { webcrypto as crypto } from 'node:crypto';

const SRC = new URL('../faces-src/', import.meta.url);
const OUT = new URL('../faces/', import.meta.url);
const ITERATIONS = 600_000;          // OWASP guidance for PBKDF2-SHA256
const EXT = /\.(jpe?g|png|webp)$/i;

// Ring colours, handed out in order. A face keeps its colour across every
// vehicle it rides, so each person effectively has one.
const RING = ['#E8C547', '#5FC9A0', '#F08A6E', '#7FB2F0',
  '#D98CC8', '#9FD356', '#F5A25D', '#6ED3D3'];

export async function deriveKey(passphrase, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,                            // non-extractable: the key cannot be read back
    ['encrypt', 'decrypt'],
  );
}

export async function seal(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;                         // IV ‖ ciphertext
}

export async function open(key, blob) {
  const data = new Uint8Array(blob);
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: data.subarray(0, 12) }, key, data.subarray(12),
  ));
}

const id = () => [...crypto.getRandomValues(new Uint8Array(6))]
  .map((b) => b.toString(16).padStart(2, '0')).join('');

// Appends to an existing faces/ without disturbing what is already there.
async function add(passphrase, names) {
  const manifestUrl = new URL('manifest.json', OUT);
  const manifest = JSON.parse(await readFile(manifestUrl, 'utf8').catch(() => 'null'));
  if (!manifest?.faces?.length || !manifest.salt) {
    console.error('No faces/manifest.json to add to. Run without --add first.');
    process.exitCode = 1;
    return;
  }

  const salt = Uint8Array.from(Buffer.from(manifest.salt, 'hex'));
  const iterations = manifest.iterations ?? ITERATIONS;
  const key = await deriveKey(passphrase, salt, iterations);

  // Probe before writing anything. A wrong passphrase here would otherwise
  // append files that decrypt to nothing on a display that is working fine,
  // and the only symptom would be a face that never appears.
  try {
    await open(key, await readFile(new URL(manifest.faces[0].file, OUT)));
  } catch {
    console.error('That passphrase does not match the files already in faces/.');
    process.exitCode = 1;
    return;
  }

  for (const [i, name] of names.entries()) {
    const bytes = await readFile(new URL(name, SRC)).catch(() => null);
    if (!bytes) {
      console.error(`Not found: faces-src/${name}`);
      process.exitCode = 1;
      return;
    }
    const file = `${id()}.bin`;
    await writeFile(new URL(file, OUT), await seal(key, bytes));
    // Carry on round the ring from where the last run stopped, so the new face
    // does not land on the colour of the one before it.
    manifest.faces.push({ id: id(), file, ring: RING[(manifest.faces.length + i) % RING.length] });
    const kb = Math.round(bytes.length / 1024);
    console.log(`  ${name.padEnd(24)} -> ${file}  (${kb} KB)`);
  }

  await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`\n${names.length} face(s) added. ${manifest.faces.length} in faces/ now.`);
  console.log('Commit faces/. Nothing else changed, so the iPad needs no new passphrase.');
}

async function main() {
  if (process.argv[2] === '--add') {
    const passphrase = process.argv[3];
    const names = process.argv.slice(4);
    if (!passphrase || !names.length) {
      console.error('Usage: node scripts/encrypt-faces.mjs --add "your passphrase" file.jpg [...]');
      process.exitCode = 1;
      return;
    }
    await add(passphrase, names);
    return;
  }

  const passphrase = process.argv[2];
  if (!passphrase) {
    console.error('Usage: node scripts/encrypt-faces.mjs "your passphrase"');
    console.error('   or: node scripts/encrypt-faces.mjs --add "your passphrase" file.jpg');
    process.exitCode = 1;
    return;
  }
  if (passphrase.length < 16) {
    // The ciphertext is public, so a short passphrase can be attacked offline.
    console.error('Passphrase is too short. Use four or more random words.');
    process.exitCode = 1;
    return;
  }

  const names = (await readdir(SRC).catch(() => [])).filter((n) => EXT.test(n)).sort();
  if (!names.length) {
    console.error(`No images in faces-src/. Put square crops there first.`);
    process.exitCode = 1;
    return;
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt);
  await mkdir(OUT, { recursive: true });

  const faces = [];
  for (const [i, name] of names.entries()) {
    const bytes = await readFile(new URL(name, SRC));
    const file = `${id()}.bin`;
    await writeFile(new URL(file, OUT), await seal(key, bytes));
    faces.push({ id: id(), file, ring: RING[i % RING.length] });
    const kb = Math.round((await stat(new URL(name, SRC))).size / 1024);
    console.log(`  ${name.padEnd(24)} -> ${file}  (${kb} KB)`);
  }

  await writeFile(new URL('manifest.json', OUT), `${JSON.stringify({
    v: 1,
    kdf: 'PBKDF2-SHA256',
    iterations: ITERATIONS,
    salt: Buffer.from(salt).toString('hex'),
    cipher: 'AES-GCM',
    faces,                            // no names: nothing identifying in the clear
  }, null, 2)}\n`);

  console.log(`\n${faces.length} face(s) encrypted into faces/.`);
  console.log('Commit faces/ — faces-src/ is gitignored and must stay that way.');
  console.log('Enter the same passphrase once on the iPad, under Settings.');
}

if (process.argv[1]?.endsWith('encrypt-faces.mjs')) await main();
