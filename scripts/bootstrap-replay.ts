import path from 'node:path';
import { bootstrapReviewedCapability } from '../src/discovery/bootstrap.ts';

const result = await bootstrapReviewedCapability(
  path.resolve('evidence/capability.json'),
  path.resolve('.local/capabilities'),
);
console.log(JSON.stringify(result, null, 2));
