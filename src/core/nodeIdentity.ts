import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NodeIdentity, CohortId } from '@porta/api-contracts';

const identityPath = path.resolve('.data', 'node-identity.json');

function cohortFromBucket(bucket: number): CohortId {
  if (bucket < 1) return 'canary-1';
  if (bucket < 5) return 'canary-5';
  return 'stable';
}

function bucketForNodeId(nodeId: string): number {
  const digest = crypto.createHash('sha256').update(nodeId).digest();
  return digest.readUInt32BE(0) % 100;
}

export function loadOrCreateNodeIdentity(clusterId = process.env.CLUSTER_ID ?? 'default'): NodeIdentity {
  if (fs.existsSync(identityPath)) {
    return JSON.parse(fs.readFileSync(identityPath, 'utf8')) as NodeIdentity;
  }

  fs.mkdirSync(path.dirname(identityPath), { recursive: true });
  const nodeId = crypto.randomUUID();
  const bucket = bucketForNodeId(nodeId);
  const identity: NodeIdentity = {
    nodeId,
    clusterId,
    instanceId: crypto.randomUUID(),
    cohortBucket: bucket,
    cohortId: cohortFromBucket(bucket)
  };

  fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2));
  return identity;
}

export function refreshInstanceId(identity: NodeIdentity): NodeIdentity {
  return { ...identity, instanceId: crypto.randomUUID() };
}
