import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { capabilityArtifactSchema } from '../contracts/capability.ts';

/** Explicitly install the reviewed demo artifact; preserve any existing catalog. */
export async function bootstrapReviewedCapability(source: string, directory: string) {
  const artifact = capabilityArtifactSchema.parse(JSON.parse(await readFile(source, 'utf8')));
  if (artifact.status !== 'validated') throw new Error('BOOTSTRAP_REQUIRES_VALIDATED_ARTIFACT');
  await mkdir(directory, { recursive: true });
  const destination = path.join(directory, `${artifact.artifactId}.json`);
  try {
    await writeFile(destination, `${JSON.stringify(artifact, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    return { status: 'installed' as const, artifactId: artifact.artifactId, destination };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = capabilityArtifactSchema.parse(
      JSON.parse(await readFile(destination, 'utf8')),
    );
    if (existing.artifactId !== artifact.artifactId)
      throw new Error('BOOTSTRAP_CATALOG_ID_MISMATCH');
    return { status: 'preserved_existing' as const, artifactId: existing.artifactId, destination };
  }
}
