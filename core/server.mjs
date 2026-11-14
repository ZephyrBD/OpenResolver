import { boot } from './boot.mjs';

const { server, config, zcode } = boot();

server.listen(config.port, config.host, () => {
  const accounts = zcode.accounts.length;
  console.log(`[Open-Resolver] http://${config.host}:${config.port}  zcode 账号 ${accounts} 个`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.close(() => process.exit(0)));
}
