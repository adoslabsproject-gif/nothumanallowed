/** nha google auth|status|revoke — Google account management */

import { runAuthFlow, showStatus, revokeAuth } from '../services/google-oauth.mjs';
import { loadConfig } from '../config.mjs';
import { fail, info } from '../ui.mjs';

export async function cmdGoogle(args) {
  const sub = args[0] || 'auth';
  const config = loadConfig();

  switch (sub) {
    case 'auth':
    case 'login':
    case 'connect':
      return runAuthFlow(config);

    case 'status':
      return showStatus();

    case 'revoke':
    case 'disconnect':
    case 'logout':
      return revokeAuth();

    default:
      fail(`Unknown: nha google ${sub}`);
      info('Commands: auth, status, revoke');
  }
}
