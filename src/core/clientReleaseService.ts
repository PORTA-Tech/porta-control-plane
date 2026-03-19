export interface WindowsClientReleaseManifest {
  platform: 'windows-x64';
  channel: string;
  version: string;
  msiUrl: string;
  publishedAtUtc: string;
  minimumSupportedVersion: string | null;
  required: boolean;
  title: string | null;
  summary: string | null;
  sha256: string | null;
}

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function readBoolean(name: string, fallback = false): boolean {
  const value = readEnv(name);
  if (!value) {
    return fallback;
  }

  switch (value.toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    default:
      return fallback;
  }
}

function normalizeIsoUtc(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString();
}

function normalizeUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      return null;
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

export function readLatestWindowsClientRelease(): WindowsClientReleaseManifest | null {
  const version = readEnv('PORTA_WINDOWS_RELEASE_VERSION') ?? readEnv('PORTA_WINDOWS_LATEST_VERSION');
  const msiUrl = normalizeUrl(readEnv('PORTA_WINDOWS_RELEASE_MSI_URL') ?? readEnv('PORTA_WINDOWS_MSI_URL'));
  if (!version || !msiUrl) {
    return null;
  }

  return {
    platform: 'windows-x64',
    channel: readEnv('PORTA_WINDOWS_RELEASE_CHANNEL') ?? 'stable',
    version,
    msiUrl,
    publishedAtUtc: normalizeIsoUtc(readEnv('PORTA_WINDOWS_RELEASE_PUBLISHED_AT_UTC')) ?? new Date().toISOString(),
    minimumSupportedVersion: readEnv('PORTA_WINDOWS_RELEASE_MIN_SUPPORTED_VERSION'),
    required: readBoolean('PORTA_WINDOWS_RELEASE_REQUIRED'),
    title: readEnv('PORTA_WINDOWS_RELEASE_TITLE'),
    summary: readEnv('PORTA_WINDOWS_RELEASE_SUMMARY'),
    sha256: readEnv('PORTA_WINDOWS_RELEASE_SHA256')
  };
}
