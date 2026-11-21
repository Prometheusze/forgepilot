// src/trueforge/sdkLoader.ts
/**
 * Single place responsible for dynamic import and caching of the ESM-only @truefoundry/trueforge-sdk module.
 */

async function importSdk() {
  return await import('@truefoundry/trueforge-sdk');
}

export type TrueForgeSdkModule = Awaited<ReturnType<typeof importSdk>>;

let cachedSdk: TrueForgeSdkModule | null = null;

export async function loadTrueForgeSdk(): Promise<TrueForgeSdkModule> {
  if (cachedSdk) {
    return cachedSdk;
  }
  try {
    const sdk = await importSdk();
    cachedSdk = sdk;
    return sdk;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load TrueForge SDK: ${message}`);
  }
}
