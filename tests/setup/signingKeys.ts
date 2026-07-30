import { generateKeyPairSync } from 'node:crypto';

/**
 * Gives the suite an ephemeral signing keypair.
 *
 * Signing has no compiled-in fallback any more, so without this the tests depend on whatever
 * happens to be on the machine: a developer with signer-private.pem in the repo root sees green,
 * CI has no such file and every signing path throws. That is exactly how the removal of the
 * fallback shipped with a passing local run and a red CI.
 *
 * A fresh pair per run is deliberate. The suite only exercises sign/verify round-trips, so any
 * valid pair works, and generating one keeps the tests hermetic -- no secret to manage, no file
 * to remember, no dependence on a gitignored artefact.
 *
 * An explicitly provided key still wins, so a real one can be injected when that is the point
 * of the run.
 */
if (!process.env.CONTROL_PLANE_SIGNING_PRIVATE_KEY_PEM || !process.env.CONTROL_PLANE_SIGNING_PUBLIC_KEY_PEM) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');

  process.env.CONTROL_PLANE_SIGNING_PRIVATE_KEY_PEM = privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();
  process.env.CONTROL_PLANE_SIGNING_PUBLIC_KEY_PEM = publicKey
    .export({ type: 'spki', format: 'pem' })
    .toString();
}
