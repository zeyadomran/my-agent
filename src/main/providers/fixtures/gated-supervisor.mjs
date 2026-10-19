// External OS boundary: a real owned process waits for explicit native startup
// release. No arbitrary delay, mocked protocol, or internal runtime replacement.
import { pathToFileURL } from 'node:url';

const launch = JSON.parse(process.env.MY_AGENT_PROCESS_LAUNCH);
process.stderr.write('Synthetic diagnostic before native readiness\n');
process.send('startup-blocked');
process.once('message', async () => {
  process.disconnect();
  if (typeof launch.readyToken === 'string') process.stderr.write(launch.readyToken);
  delete process.env.MY_AGENT_PROCESS_LAUNCH;
  process.argv = [launch.executable, ...launch.args];
  await import(pathToFileURL(launch.args[0]).href);
});
