/** nha microsoft auth|status|revoke — Microsoft account management */

import { runMicrosoftAuthFlow, showMicrosoftStatus, revokeMicrosoftAuth } from '../services/microsoft-oauth.mjs';
import { loadConfig } from '../config.mjs';
import { fail, info } from '../ui.mjs';

export async function cmdMicrosoft(args) {
  const sub = args[0] || 'auth';
  const config = loadConfig();

  switch (sub) {
    case 'auth':
    case 'login':
    case 'connect':
      return runMicrosoftAuthFlow(config);

    case 'status':
      return showMicrosoftStatus();

    case 'revoke':
    case 'disconnect':
    case 'logout':
      return revokeMicrosoftAuth();

    default:
      fail(`Unknown: nha microsoft ${sub}`);
      info('Commands: auth, status, revoke');
  }
}
