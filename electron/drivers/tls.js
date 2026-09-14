import { readFileSync } from 'node:fs'

/**
 * Reads one PEM file named by a profile. A path that cannot be read is the
 * user's to fix, so the error names the file and the reason rather than
 * letting the TLS layer fail later with nothing to go on.
 */
function readPem(filePath, what) {
  if (!filePath) return undefined

  try {
    return readFileSync(filePath)
  }
  catch (error) {
    throw new Error(
      error.code === 'ENOENT'
        ? `No ${what} at ${filePath}.`
        : `Cannot read the ${what} at ${filePath}: ${error.code ?? error.message}.`,
      { cause: error },
    )
  }
}

/**
 * The `ssl` option a server driver hands its pool, built from a profile.
 *
 * Off means no TLS at all, exactly as before. On is encrypt-only unless the
 * profile asks for the server's certificate to be verified, in which case the
 * CA it names — or the system's roots, when it names none — is what the chain
 * is checked against. A client certificate and key are passed through when
 * given, for servers that authenticate that way.
 *
 * The files are read here, once, when the pool is opened: the connection
 * dialog's Test then surfaces a bad path before anything is saved, and the
 * drivers never touch the disk again for the life of the session.
 */
export function tlsOptions(profile) {
  if (!profile.ssl) return undefined

  return {
    rejectUnauthorized: Boolean(profile.sslVerify),
    ca: readPem(profile.sslCa, 'CA certificate'),
    cert: readPem(profile.sslCert, 'client certificate'),
    key: readPem(profile.sslKey, 'client key'),
  }
}
