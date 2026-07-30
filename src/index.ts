import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { registerSyncWebdavCommands } from './commands.js';

export default function registerSyncWebdav(pi: ExtensionAPI): void {
	registerSyncWebdavCommands(pi);
}
