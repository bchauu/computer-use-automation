import { configureAutomation, defaultSessionRegistry } from './server.ts';
import { startService } from '../shared/start-service.ts';

startService(
  'automation',
  3001,
  process.env.AUTOMATION_MONGODB_URI,
  (app, database) => {
    configureAutomation(app, database);
  },
  () => defaultSessionRegistry.closeAll(),
);
